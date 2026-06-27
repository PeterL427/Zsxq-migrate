# download-files.mjs — 知识星球文件批量下载脚本

> **版本**: v2.2  
> **运行环境**: Node.js >= 20（需 `import.meta.dirname`）  
> **依赖**: zsxq-cli v0.4.x（通过 npx 调用）

## 1. 核心功能

通过 `zsxq-cli` 的命令行接口（shortcut / raw API）获取知识星球中指定星球的主题列表和详情，再利用浏览器 Cookie 调用下载 API，**批量将话题附件和图片保存到本地**。

## 2. 整体架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  config.json │────▶│  参数合并层   │◀────│  命令行参数   │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │   main() 主流程   │
                  └────────┬────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                  ▼
   ┌───────────┐   ┌──────────────┐   ┌──────────────┐
   │ zsxq()    │   │ httpRequest()│   │ downloadFile()│
   │ execSync  │   │  (Cookie 认证)│   │  (流式下载)   │
   │ npx zsxq  │   └──────────────┘   └──────────────┘
   └───────────┘
```

## 3. 模块划分

### 3.1 配置层

```
loadConfig() → EXTERNAL_CONFIG (模块级常量)
                    │
                    ├── cookie        (zsxq_access_token)
                    ├── groupId       (默认星球 ID)
                    ├── limit         (默认 50)
                    ├── output        (默认 ./downloads)
                    └── rateLimitMs   (默认 1500ms)
```

- `config.json` 不存在时，回退为空对象，所有值需通过命令行传入
- 命令行参数优先级 > 配置文件

### 3.2 命令行接口（zsxq）

封装 `execSync` 调用 `npx zsxq-cli`，返回解析后的 JSON 对象。

```js
zsxq("topic +detail --topic-id 123456")  // shortcut 调用
zsxq("api call get_group_topics --params ...")  // raw API 调用
```

- 超时 30 秒，缓冲区 50MB
- 失败时返回 `null`
- Windows 下 JSON 参数需用 `""` 双引号转义

### 3.3 HTTP 下载层

| 函数 | 职责 |
|------|------|
| `httpRequest(url, cookie)` | 通用 GET 请求，支持 Cookie、重定向，返回 JSON/文本 |
| `resolveDownloadUrl(fileId)` | 调 `GET /v2/files/{id}/download_url` 解析附件真实下载链接 |
| `downloadFile(url, destPath)` | 流式下载到本地文件，实时显示进度百分比 |

### 3.4 主题处理

```
getTopicDetail(topicId)        → 调用 shortcut: topic +detail
      │
      ▼
extractFilesFromTopic(topic)   → 从 3 个来源提取文件
      │
      ├── topic.files[]        → 附件列表（.pdf/.xlsx/.zip 等，通过 file_id 下载）
      ├── topic.images[]       → 图片列表（取 original > large > medium > small）
      └── topic.content        → 正则匹配 Markdown ![]() 和 HTML <img> 中的内嵌图片
```

每个文件对象结构：

```json
{
  "fileId": "xxx",      // null 表示直接 URL
  "directUrl": "xxx",   // 图片直接链接
  "name": "文件名",
  "size": 12345,
  "type": "file|image"
}
```

## 4. 主流程

```
main()
├── 1. parseArgs()          解析命令行参数
├── 2. 合并 config.json     命令行 > 配置文件 > 默认值
├── 3. 验证 Cookie          若无则提示退出
├── 4. 获取主题列表         调用 get_group_topics API
│     ├── --group-id   → 批量获取（最多 limit 条）
│     └── --topic-id   → 单个主题
├── 5. 创建输出目录          mkdir -p
├── 6. 遍历每个主题
│     ├── getTopicDetail()   获取详情
│     ├── extractFilesFromTopic() 提取文件
│     ├── 应用过滤规则       imagesOnly / filesOnly
│     ├── 每个文件:
│     │   ├── 跳过已存在文件
│     │   ├── 附件: resolveDownloadUrl() → 获取下载链接
│     │   ├── 图片: directUrl 直接下载
│     │   ├── downloadFile() → 流式下载 + 进度条
│     │   └── rateLimit() → 间隔 ≥1.5s
│     └── 收集失败记录
└── 7. 输出汇总              成功/失败统计 + 失败列表
```

## 5. 命令行参数

| 参数 | 说明 | 配置文件对应 |
|------|------|-------------|
| `--group-id <id>` | 星球 ID | `groupId` |
| `--topic-id <id>` | 单个主题 ID | — |
| `--cookie <token>` | 浏览器 Cookie | `cookie` |
| `--limit <n>` | 最多获取主题数 | `limit` |
| `--output <dir>` | 输出目录 | `output` |
| `--dry-run` | 干跑模式（只列不下载） | — |
| `--images-only` | 仅下载图片 | — |
| `--files-only` | 仅下载附件 | — |
| `--help / -h` | 显示帮助 | — |

## 6. 常量配置

| 常量 | 值 | 说明 |
|------|-----|------|
| `CLI` | `npx zsxq-cli` | CLI 调用前缀 |
| `API_BASE` | `https://api.zsxq.com/v2` | 下载 API 基础路径 |
| `RATE_LIMIT_MS` | 1500 | 请求间隔（毫秒），可从配置覆盖 |
| `IMAGE_EXTS` | 8 种 | 图片扩展名白名单 |
| `FILE_EXTS` | 24 种 | 常见附件扩展名 |

## 7. 数据流示意

```
用户命令
  │
  ▼
config.json ──▶ cookie ──────────────┐
                groupId ───┐         │
                           ▼         ▼
zsxq-cli ◀── get_group_topics ──▶ [topics_brief[]]
  │                                    │
  │                               topic_id[]
  ▼                                    │
zsxq-cli ◀── topic +detail ──────────┘
  │
  ▼
{ topic: { files[], images[], content } }
  │
  ▼
提取 file_id[] ──▶ Cookie ──▶ /v2/files/{id}/download_url
提取 directUrl[] ────────────▶ 直接 HTTP 下载
  │
  ▼
流式下载 + 进度条 → ./downloads/{topicId}_{filename}
```

## 8. 关键设计决策

1. **双重认证体系**: zsxq-cli 负责 OAuth 认证获取主题数据，Cookie 负责文件下载鉴权，两者解耦
2. **速率限制**: 每 1.5 秒一次请求，避免触发服务端限流
3. **断点续传**: 通过检测文件是否存在自动跳过已下载项
4. **渐进式降级**: 配置文件缺失 → 命令行 → 默认值 → 报错退出
5. **跨平台兼容**: JSON 参数在 Windows(cmd.exe) 和 Unix(POSIX shell) 下分别处理转义
