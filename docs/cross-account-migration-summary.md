# 跨账号主题迁移 — 全流程总结

> 从"能否切换账号"到"15 条主题成功搬运"，完整记录问题、决策、方案。

## 一、问题演进

### 1.1 起点：多账号切换

**需求**：在 `config.json` 里直接切换 `zsxq-cli` 的用户认证。

**发现**：CLI 认证有两层——

| 层 | 存储 | 切换方式 |
|----|------|---------|
| CLI OAuth Token | 系统 Keychain | `auth logout` → `auth login` |
| Cookie (下载用) | `config.json` | 直接改 `cookie` 字段 |

**结论**：OAuth Token 不能通过配置文件切换，必须走浏览器授权流程。但 `config.json` 里的 cookie 可以一键切换。

### 1.2 转折：发现 MCP API Key

用户提供了两个 32 位 hex：`6b38c76...` 和 `cde5fe...`。

- 尝试作为 `zsxq_access_token` cookie → **401**
- 尝试作为 Bearer Token → **401**
- 尝试 MCP URL 参数 → **连接成功** ✅

```json
{"mcpServers":{"zsxq":{"url":"https://mcp.zsxq.com/topic/mcp?api_key=cde5fe..."}}}
```

**结论**：这是 MCP 的 API Key，不是浏览器 cookie。切换 api_key 即切换账号。

### 1.3 MCP 配置项目化

从全局 `~/.codebuddy/mcp.json` 移至项目级 `.codebuddy/mcp.json`，随项目版本控制。

---

## 二、架构设计

### 2.1 config.json 多 Profile 改造

```json
{
  "activeProfile": "account1",
  "profiles": {
    "account1": {
      "mcpApiKey": "6b38c7...",   // MCP 脚本用
      "cookie": "zsxq_access_token=...", // CLI 脚本用
      "groupId": "88882114281542",
      "output": "./downloads",
      "limit": 50,
      "rateLimitMs": 1500
    },
    "account2": {
      "mcpApiKey": "cde5fe...",
      "groupId": "48885244111858",
      ...
    }
  }
}
```

`download-files.mjs` 和 `download-files-mcp.mjs` 复用同一份配置，通过 `--profile` 切换。

### 2.2 双脚本体系

| 脚本 | 依赖 | 认证 | 用途 |
|------|------|------|------|
| `download-files.mjs` | zsxq-cli + Cookie | OAuth + Cookie | 本地下载 |
| `download-files-mcp.mjs` | **零依赖** | MCP API Key | 服务器/本地下载 |

### 2.3 迁移脚本三层架构

```
migrate.mjs
├── 读取层: account2 MCP（cde5fe key）
│   ├── get_group_topics     → 主题列表
│   └── get_topic_info       → 主题详情（body + images + files + tags）
│
├── 下载层: HTTP 直连 CDN
│   ├── img.original.url     → 下载原图
│   └── /v2/files/{id}/download_url → 下载附件
│
├── 发布层: 按类型分流
│   ├── 纯文字 → account1 MCP create_topic（换行正确）
│   └── 带文件 → zsxq-cli topic +create --files（CLI 上传）
│
└── 标签层: account1 MCP set_topic_tags
```

---

## 三、核心问题与解决方案

### 3.1 文件上传 — MCP 为什么不行

**问题**：MCP `call_zsxq_api` 无法上传图片/附件。

**排查过程**：

| 尝试 | 结果 |
|------|------|
| MCP `call_zsxq_api` → `POST /v2/images/upload` | Upstream request failed |
| MCP `call_zsxq_api` → `POST /v2/files/upload` | Upstream request failed |
| 直连 Cookie → `POST /v2/images/upload` | 404 HTML |
| 直连 Cookie → `POST /v2/*/upload` | 全部 404 |

**根因**：三层断裂——

```
call_zsxq_api
  ↓ JSON body { key: value }
  ↓ MCP Server 转发 Content-Type: application/json
  ↓ zsxq API 收到 JSON → 不认识文件
```

而文件上传需要 `multipart/form-data`：
```
POST /v2/upload
Content-Type: multipart/form-data; boundary=----xxx
[二进制字节流]
```

JSON-RPC 协议层面不支持二进制流传输，`call_zsxq_api` 的 `body` 参数只能传 JSON 对象。

**突破**：CLI `topic +create` 的 `--files` 参数。CLI 在本地进程直接构造 `multipart/form-data` 请求发给上传接口，绕过了 MCP 的 JSON 层。

```
zsxq-cli topic +create --files "local/img.jpg" →
  本地进程直连 → multipart/form-data → 上传接口 → image_id → create_topic
```

详见 [cross-account-file-limitation.md](cross-account-file-limitation.md)。

### 3.2 中文乱码

**问题**：PS1 中发布的中文帖子在星球里显示乱码。

**原因**：PowerShell `Get-Content` 默认编码可能是系统的 GBK/ANSI，读取 UTF-8 文件时误码。

**解决**：

```powershell
chcp 65001 | Out-Null                                    # 控制台切 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8  # 输出编码
$t = Get-Content 'file.txt' -Raw -Encoding UTF8           # 强制 UTF-8 读取
```

同时在写入文件时加 BOM 头：
```javascript
writeFileSync(textFile, '\uFEFF' + content, 'utf-8');
```

### 3.3 正文换行丢失

**问题**：CLI `--text "第一行\n第二行"` → 只保留了"第一行"，后续内容丢失。

**根因**：CLI 的 `--text` 参数在命令行解析时会遇到真实换行符 `0x0A`，Go 的 flag 库默认在第一个换行处截断。

**测试验证**：
```bash
npx zsxq-cli topic +create --text "第一行`n第二行`n第三行" --json
# → "text": "第一行"  ← 只保留了第一行
```

**解决**：纯文字帖改用 MCP `create_topic`（JSON 天然支持 `\n` → 真实换行）：

```javascript
// MCP JSON 请求
{
  "method": "tools/call",
  "params": {
    "name": "create_topic",
    "arguments": {
      "content": "第一行\n\n第二行\n\n第三行"  // JSON \n → 真实换行
    }
  }
}
```

Hex 级别验证：
```
原帖: ...e7ab8b 0a0a e4bb8a...  ← 真实换行
新帖: ...e7ab8b 0a0a e4bb8a...  ← 完全一致
```

### 3.4 图片文件名

**问题**：下载的图片文件名为 `unknown`，无扩展名。

**根因**：MCP 返回的图片对象结构：
```json
{
  "image_id": "1525415444444182",
  "type": "png",
  "original": { "url": "https://images.zsxq.com/Fxxx?...", "size": 184088 },
  "large": { "url": "https://images.zsxq.com/Fxxx?...", "width": 800 }
}
```
- `name` 字段不存在
- `original` 是对象 `{url, height, size}`，不是字符串

**修复**：
1. 用 `img.original?.url` 提取 URL
2. 用 CDN hash（如 `Fjibh4yS9c8VudgJhgwFNTQG-uqX`）作文件名
3. 用 `img.type`（`png`/`jpg`/`gif`）确定扩展名

### 3.5 Emoji 显示 `�`

**问题**：部分帖子开头/段落间的 emoji（📊 🚀 等）显示为 `�`。

**排查**：十六进制验证原帖 API 返回内容 `efbfbd` = `\uFFFD`（Unicode 替换字符）。

**结论**：不是传输编码问题。这些字符在原帖的知识星球存储中已经损坏。**属于平台数据层面的问题，不在脚本控制范围**。

### 3.6 JSON 解析异常

**问题**：CLI `+create --json` 输出混入进度文字：
```
↑ [1/1] img.jpg uploaded (image)
✓ Topic created
{ "success": true, "topic": {...} }
```

**修复**：提取从 `{` 开始的 JSON 部分：
```javascript
const jsonStart = stdout.indexOf('{');
const data = JSON.parse(stdout.slice(jsonStart));
```

---

## 四、最终调用链路

### 4.1 文字帖发布

```
migrate.mjs
  │
  ├─ (1) account2 MCP: get_group_topics(group_id, limit)
  │     └→ topics_brief[{ topic_id, type, ... }]
  │
  ├─ (2) account2 MCP: get_topic_info(topic_id)
  │     └→ topic.title, topic.content, topic.images[], topic.files[]
  │
  ├─ (3) parseHashtags(content)
  │     └→ ["#文字#", "#链接#"]
  │
  ├─ (4) account1 MCP: create_topic(
  │       group_id, content, image_ids=[], file_ids=[])
  │     └→ { topic_id: "xxx" }
  │
  └─ (5) account1 MCP: set_topic_tags(topic_id, titles=["#文字#"])
        └→ success
```

### 4.2 带文件帖发布

```
migrate.mjs
  │
  ├─ (1)~(3) 同文字帖
  │
  ├─ (4a) 图片下载:
  │       HTTP GET img.original.url → ./migrate-temp/img_N.png
  │
  ├─ (4b) 附件下载:
  │       account2 MCP: call_zsxq_api(GET, /v2/files/{id}/download_url)
  │       HTTP GET download_url → ./migrate-temp/file.pdf
  │
  ├─ (5) zsxq-cli: topic +create
  │       --group-id 88882114281542
  │       --text "content\nwith\nnewlines"
  │       --files "img_1.png,file.pdf"
  │     └→ { topic_id: "xxx" }
  │
  └─ (6) account1 MCP: set_topic_tags(topic_id, titles)
```

### 4.3 标签解析

原帖标签在 content 中以 HTML 实体形式存在：
```
<e type="hashtag" hid="28248412128221" title="%23%E6%96%87%E5%AD%97%23" />
```

解析流程：
```javascript
function parseHashtags(content) {
  const regex = /<e\s+type="hashtag"[^>]*title="([^"]+)"[^>]*\/>/g;
  // title="%23%E6%96%87%E5%AD%97%23" → decodeURIComponent → "#文字#"
}
```

---

## 五、MCP 工具矩阵

### 5.1 读取侧（account2，cde5fe）

| 工具 | 参数 | 用途 |
|------|------|------|
| `get_group_topics` | `group_id`, `limit` | 获取星球主题列表 |
| `get_topic_info` | `topic_id` | 获取主题完整详情 |
| `call_zsxq_api` | `method:GET`, `path:/v2/files/{id}/download_url` | 解析附件下载链接 |

### 5.2 发布侧（account1，6b38c7）

| 工具 | 参数 | 用途 |
|------|------|------|
| `create_topic` | `group_id`, `content`, `image_ids`, `file_ids` | 创建文字帖（换行正确） |
| `set_topic_tags` | `topic_id`, `titles` | 打标签 |

### 5.3 CLI 兜底（account1 OAuth）

| 命令 | 参数 | 用途 |
|------|------|------|
| `topic +create` | `--group-id`, `--text`, `--files` | 创建带文件帖（唯一支持上传的方式） |

---

## 六、脚本清单

| 文件 | 依赖 | 说明 |
|------|------|------|
| `download-files.mjs` | zsxq-cli + Cookie | CLI 版下载脚本 v2.3 |
| `download-files-mcp.mjs` | **无** | MCP 版下载脚本 v1.0 |
| `migrate.mjs` | zsxq-cli (仅文件帖) | 跨账号迁移脚本 v1.0 |
| `config.json` | — | 多 profile 配置 |
| `docs/cross-account-migration-plan.md` | — | 迁移实施计划 |
| `docs/cross-account-file-limitation.md` | — | 文件上传局限性分析 |
| `docs/download-files-mcp.md` | — | MCP 版下载脚本文档 |

---

## 七、运行结果

```
累计迁移: 15 条
  纯文字: 10 条 ✅
  带图片: 4 条 ✅
  带附件: 1 条 ✅
  失败:   0 条

标签搬运: #文字# #链接# #财联社# #图片#
文字编码: 中文正常
换行格式: 与原帖 hex 一致
```

---

## 八、已知边界

| 场景 | 处理 |
|------|------|
| Q&A 提问帖 | 跳过 |
| 9 张图图片帖 | ✅ 全量上传 |
| 带 PDF 附件帖 | ✅ CLI 上传附件 |
| Emoji 显示 `�` | 原帖数据已损坏，非脚本问题 |
| 超过 50 条的星球 | `get_group_topics` 默认取最新 50 条 |
| 多账号切换 | `--profile account1/account2` 或改 `activeProfile` |
