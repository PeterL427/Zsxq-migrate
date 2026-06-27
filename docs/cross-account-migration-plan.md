# 跨账号主题迁移 — 实施计划

> **目标**：从 account2 每日投研(48885244111858)取最近 50 条主题，搬运到 account1 极速投研(88882114281542)，包含文字、图片、附件，全部以 account1 身份发布。

## 1. 架构

```
┌─────────────────────────────────┐
│          migrate.mjs            │
├─────────────────────────────────┤
│ 阅读层: MCP (account2 api_key)  │
│ 下载层: HTTP CDN (图片/附件)    │
│ 发布层: zsxq-cli (account1 OAuth)│
│ 打标层: MCP (account1 api_key)  │
└─────────────────────────────────┘
```

| 操作 | 工具 | 账号 |
|------|------|------|
| 获取主题列表 + 详情 | MCP `get_group_topics` + `get_topic_info` | account2 |
| 下载图片/附件到本地 | HTTP 直连 CDN `original.url` | 无认证 |
| 创建主题（含文件） | CLI `topic +create --files` | account1 |
| 设置标签 | MCP `set_topic_tags` | account1 |

## 2. 数据流

每个主题的处理流程：

```
get_topic_info(topic_id)
      │
      ├── 跳 topic.type === 'q&a'（跳过提问）
      │
      ├── 正文: topic.content（直接原样发布，不加标题）
      │
      ├── 图片处理:
      │   ├── 遍历 topic.images[]
      │   ├── 下载 original.url → {temp}/topicId/img_N.xxx
      │   └── 收集本地路径列表
      │
      ├── 附件处理:
      │   ├── 遍历 topic.files[]
      │   ├── MCP getDownloadUrl(file_id) → 下载 URL
      │   ├── 下载 → {temp}/topicId/file_name.pdf
      │   └── 收集本地路径列表
      │
      ├── 创建主题:
      │   └── CLI topic +create --group-id 888... --text "正文" --files "路径1,路径2,..."
      │
      ├── 打标签 (如果原主题有 hashtag):
      │   └── MCP set_topic_tags(topic_id, titles)
      │
      └── 记录映射: { sourceTopicId → newTopicId }
```

## 3. 主题分类处理

根据之前样本分析，每日投研的主题分为：

| 类型 | 特征 | 处理方式 | 占比估算 |
|------|------|----------|:--------:|
| 纯文字公告 | 有标题，无图无附件 | CLI `+create`（无 `--files`） | ~60% |
| 带图片帖子 | 有标题，有 images | CLI `+create --files` | ~20% |
| 带附件帖子 | 有标题，有 files | CLI `+create --files` | ~15% |
| 纯标签帖 | title="#标签"，无正文 | 跳过或合并 | ~5% |
| Q&A 提问 | type="q&a" | 跳过 | 极少 |

## 4. 标题处理策略

**不搬运原标题**，CLI `topic +create --text` 直接传入原 `topic.content`。

| 原主题 | 发布内容 | 展示效果 |
|--------|----------|---------|
| title="【永太科技…】" content="永太科技公告..." | 永太科技公告... | ✅ 纯正文 |
| title="#财联社" content="&lt;e hashtag/&gt;" | &lt;e hashtag/&gt; | ✅ 标签展示 |
| 无标题 | 原文 | ✅ 直接展示 |

**CLI 传参**：`--text "topic.content 原始正文"`，不在前面加 title。

## 5. CLI 传参方案

### 正文

多行长文本直接通过 `--text` 传入，PowerShell 下用 here-string：

```powershell
$body = @"
【永太科技：子公司与宁德时代签电解液协议...】

永太科技公告，公司全资子公司...
"@
npx zsxq-cli topic +create --group-id 88882114281542 --text $body
```

或使用 `.mjs` 脚本内部 `execSync` 传递，避免 shell 转义问题。

### 文件

```bash
--files "downloads/temp/topic123/img_1.jpg,downloads/temp/topic123/doc.pdf"
```

逗号分隔，CLI 自动识别图片/附件类型并上传。

## 6. 标签迁移

原主题标签存在于两种形式：

**形式 1**：content 中的 `<e type="hashtag" hid="xxx" title="%23标签名%23" />`

解析 title 属性：`%23` 是 `#` 的 URL 编码，`decodeURIComponent` 后得到 `#标签名`。

**形式 2**：topic 自身的标签系统（如 `topic.hashtags`）

示例主题中 `hashtags: []` 为空，标签全在 content 里。

**迁移方式**：创建主题后，用 `set_topic_tags` 给新帖子打标：

```
MCP: set_topic_tags(topic_id, titles: ["#标签1", "#标签2"])
```

## 7. 速率与防重复

| 控制项 | 策略 |
|--------|------|
| 请求间隔 | 每发布 1 条等待 2 秒（CLI 上传较慢） |
| 防重复 | 维护 `migrated.json` 记录已搬运的 `sourceTopicId → newTopicId` |
| 断点续传 | 启动时读取 migrated.json，跳过已完成的 topic |
| 重试 | 失败 topic 记录到 `failed.json`，手动排查 |

## 8. 文件结构

```
zsxq_test/
├── migrate.mjs              ← 主脚本
├── migrate-record.json      ← 搬运记录（自动生成）
├── migrate-failed.json      ← 失败日志（自动生成）
├── migrate-temp/            ← 临时下载目录（运行后自动清空）
│   └── {topic_id}/
│       ├── img_1.jpg
│       └── file_1.pdf
├── config.json              ← 已有，复用 profiles
└── .codebuddy/
    └── mcp.json             ← account1 的 MCP key（用于 set_topic_tags）
```

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| 原主题无标题无正文 | 跳过，记录到 idle |
| 图片下载失败 | 跳过该图片，仅发文字 |
| 附件下载失败 | 跳过该附件，仅发文字 |
| CLI 创建失败 | 记录到 failed.json，继续下一条 |
| 标签设置失败 | 非致命错误，warn 并继续 |
| MCP 断开 | 重试 3 次，仍失败则终止 |

## 10. 运行方式

```bash
# 干跑预览（只显示将要搬运的内容，不实际发布）
node migrate.mjs --dry-run

# 正式执行 50 条
node migrate.mjs --limit 50

# 续传（从上次中断处继续）
node migrate.mjs --resume
```

## 11. 已知限制

| 限制 | 说明 |
|------|------|
| 依赖 zsxq-cli | account1 需保持 CLI 登录态（`zsxq-cli auth login`） |
| 附件需下载 | 图/文件先下载到本地再上传，消耗带宽和磁盘 |
| 标签格式 | 仅解析 content 中的 `<e hashtag/>` 标签 |
| 不支持 Q&A | `+create` 只能创建 talk 类型 |

## 12. 下一步

1. 编写 `migrate.mjs` 主脚本
2. `--dry-run` 模式预跑验证
3. 正式执行 50 条搬运
