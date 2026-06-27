# download-files-mcp.mjs — 纯 MCP 知识星球文件下载脚本

> **版本**: v1.0  
> **运行环境**: Node.js >= 18（需原生 `fetch`）  
> **依赖**: 无外部依赖，仅需 MCP API Key

## 1. 核心功能

通过 zsxq MCP 服务器的 JSON-RPC 协议获取星球主题列表和详情，批量下载附件和图片到本地。

**与 CLI 版本对比**：

| 特性 | CLI 版 (`download-files.mjs`) | MCP 版 (`download-files-mcp.mjs`) |
|------|------------------------------|-----------------------------------|
| 依赖 | `zsxq-cli` (npm)、浏览器 Cookie | **无外部依赖** |
| 认证 | Cookie + OAuth 双重 | **仅 MCP API Key** |
| 服务器可用 | ❌ 需浏览器 OAuth 登录 | ✅ 纯 HTTP，任意环境 |
| API 调用 | `execSync` 调用 CLI | `fetch` 直连 MCP |

## 2. 架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  config.json │────▶│  参数合并层   │◀────│  命令行参数   │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │ McpClient 客户端  │  JSON-RPC 2.0
                  │  (fetch + SSE)  │  over HTTP
                  └────────┬────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                  ▼
   ┌───────────┐   ┌──────────────┐   ┌──────────────┐
   │get_group  │   │call_zsxq_api │   │ downloadFile()│
   │ _topics   │   │  (万能 API)   │   │  (流式下载)   │
   └───────────┘   └──────────────┘   └──────────────┘
```

## 3. 模块划分

### 3.1 McpClient

封装 JSON-RPC 2.0 协议，管理 MCP 会话生命周期：

- `init()` → `initialize` 握手 + `notifications/initialized` 通知
- `callTool(name, args)` → 调用 MCP 工具
- `_rpc(method, params)` → 底层请求，解析 SSE 响应

```js
const client = new McpClient(apiKey);
await client.init();                        // 握手
await client.callTool('get_group_topics', { group_id: 'xxx', limit: 10 });
await client.callTool('call_zsxq_api', { method: 'GET', path: '/v2/topics/123' });
```

### 3.2 API 封装层

| 函数 | MCP 工具 | 说明 |
|------|---------|------|
| `getGroupTopics(client, groupId, limit)` | `get_group_topics` | 获取星球主题列表 |
| `getTopicDetail(client, topicId)` | `call_zsxq_api` → `/v2/topics/{id}` | 获取主题详情（含 files/images） |
| `getDownloadUrl(client, fileId)` | `call_zsxq_api` → `/v2/files/{id}/download_url` | 解析附件真实下载链接 |

### 3.3 文件下载层

| 函数 | 职责 |
|------|------|
| `downloadFile(url, destPath)` | Node.js 原生 HTTP 流式下载，支持重定向、进度显示 |

## 4. 主流程

```
main()
├── 1. parseArgs()               解析命令行
├── 2. resolveProfile()          读取 config.json 对应 profile
├── 3. new McpClient(mcpApiKey)  创建 MCP 客户端
├── 4. client.init()             握手
├── 5. 获取主题列表
│     ├── --group-id → getGroupTopics()
│     └── --topic-id → 单个主题
├── 6. 创建输出目录
├── 7. 遍历每个主题
│     ├── getTopicDetail()        MCP call_zsxq_api
│     ├── extractFilesFromTopic() 提取文件
│     ├── 过滤 imagesOnly / filesOnly
│     └── 每个文件:
│         ├── 图片: directUrl 直接下载
│         ├── 附件: getDownloadUrl() → downloadFile()
│         └── rateLimit() 控速
└── 8. 输出汇总
```

## 5. 命令行参数

| 参数 | 说明 | 配置对应 |
|------|------|----------|
| `--group-id <id>` | 星球 ID | `profiles.{name}.groupId` |
| `--topic-id <id>` | 单个主题 ID | — |
| `--profile <name>` | 指定账号 profile | `activeProfile` |
| `--mcp-api-key <k>` | 直接传入 MCP API Key | `profiles.{name}.mcpApiKey` |
| `--limit <n>` | 最多获取主题数 | `profiles.{name}.limit` |
| `--output <dir>` | 输出目录 | `profiles.{name}.output` |
| `--rate-limit <ms>` | 请求间隔 | `profiles.{name}.rateLimitMs` |
| `--dry-run` | 干跑模式 | — |
| `--images-only` | 仅图片 | — |
| `--files-only` | 仅附件 | — |

## 6. config.json 配置

```json
{
  "activeProfile": "account1",
  "profiles": {
    "account1": {
      "mcpApiKey": "从 MCP 配置获取的 api_key",
      "groupId": "星球 ID",
      "output": "./downloads",
      "limit": 50,
      "rateLimitMs": 1500
    }
  }
}
```

## 7. 数据流

```
config.json
  │
  ▼
mcpApiKey ──▶ McpClient ──▶ JSON-RPC ──▶ https://mcp.zsxq.com/topic/mcp
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
            get_group_topics        call_zsxq_api           call_zsxq_api
            (主题列表)             GET /v2/topics/{id}     GET /v2/files/{id}
                    │                 (主题详情)              (下载链接)
                    ▼                      │                      │
              topics_brief[]         files[] + images[]      download_url
                                          │                      │
                                          └──────────────────────┘
                                                    │
                                                    ▼
                                           downloadFile()
                                          (流式下载到本地)
```

## 8. 服务器部署

```bash
# 1. 配置 API Key
cp config.example.json config.json
# 编辑 config.json，填写 mcpApiKey 和 groupId

# 2. 直接运行（无需安装任何依赖）
node download-files-mcp.mjs --group-id 88882114281542 --limit 20

# 3. 定时任务（crontab）
# 每天凌晨 3 点下载最近 20 个主题的文件
0 3 * * * cd /app && node download-files-mcp.mjs --group-id 88882114281542 --limit 20
```

## 9. 关键设计决策

1. **零依赖**：Node.js >= 18 原生 `fetch`，无需 npm install
2. **MCP 协议**：JSON-RPC 2.0 over HTTP + SSE，标准可扩展
3. **万能 API**：`call_zsxq_api` 可调用任意知识星球 API，不受工具列表限制
4. **速率控制**：默认 1.5s 间隔，可配置
5. **断点续传**：检测已有文件自动跳过
6. **多账号**：复用 config.json profiles 体系，一键切换
