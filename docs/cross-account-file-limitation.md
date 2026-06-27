# 跨账号文件迁移 — MCP 局限性分析报告

> 需求：从账号2 "每日投研" 搬运主题（含图片/附件）到账号1 "极速投研"，保持原格式。

## 一、为什么纯 MCP 无法搬运图片/附件

### 1.1 核心矛盾

```
读取侧（账号2 MCP）      →      上传到账号1      →      发布侧（账号1 MCP）
get_group_topics ✅           需要 upload API ❌         create_topic ✅
get_topic_info   ✅           不存在公开上传接口         需要 image_ids/file_ids
图片/文件数据可获取           无法获得新的 image_id        不接受本地路径或 URL
```

### 1.2 完整流程拆解

#### Step 1：读取 ✅ 没问题

```
MCP: get_topic_info → topic.images[] → { image_id, type, original.url, ... }
                   → topic.files[]   → { file_id, name, size }
```

图片/文件的原始数据可以通过 `original.url` 直接 HTTP 下载到本地，这一步已在 `download-files-mcp.mjs` 验证通过。

#### Step 2：上传到账号1 ❌ 无公开接口

这是整个流程的断裂点。

##### 验证过程

**尝试 1：MCP `call_zsxq_api` 上传**

```
MCP call_zsxq_api → POST /v2/images/upload  → "Upstream service request failed"
MCP call_zsxq_api → POST /v2/files/upload   → "Upstream service request failed"
MCP call_zsxq_api → POST /v3/images/upload  → 404
MCP call_zsxq_api → POST /v3/files/upload   → 404
MCP call_zsxq_api → POST /v2/upload         → "Upstream service request failed"
```

**失败原因**：`call_zsxq_api` 只能发送 `Content-Type: application/json`，body 为 JSON 对象。但文件上传接口需要 `multipart/form-data` 格式传输二进制数据。MCP 协议层面不支持二进制流传输。

**尝试 2：直接 HTTP + Cookie 上传**

```
POST https://api.zsxq.com/v2/files/upload  → 404 (HTML "页面未找到")
POST https://api.zsxq.com/v2/images/upload → 404 (HTML "页面未找到")
POST https://api.zsxq.com/v3/files/upload  → 404 (JSON error)
POST https://api.zsxq.com/v3/images/upload → 404 (JSON error)
```

**失败原因**：知识星球 API 不提供公开的文件上传端点。上传功能仅在客户端（App/Web）内实现，通过私有协议完成，未暴露为 REST API。

#### Step 3：发布主题 ✅ 但需要 image_ids

```
MCP: create_topic → 参数 { group_id, title, content, image_ids, file_ids }
```

`create_topic` 要求 `image_ids` 是**已在目标星球服务器上存在的图片 ID**（字符串数组），不接受：
- 本地文件路径（如 `./downloads/xxx.jpg`）
- 第三方 URL（如 `https://images.zsxq.com/xxx`）
- Base64 编码数据

### 1.3 MCP 可用工具清单

```
MCP 工具列表
├── get_group_topics          ✅ 获取主题列表
├── get_topic_info            ✅ 获取主题详情（含图片/文件元数据）
├── create_topic              ✅ 创建主题（需要 image_ids/file_ids）
├── set_topic_tags            ✅ 设置标签
├── create_topic_comment      ✅ 发表评论
├── call_zsxq_api             ⚠️ 万能 API 调用（仅 JSON body）
│   ├── GET  /v2/topics/{id}  ✅
│   ├── GET  /v2/files/{id}/download_url  ✅
│   └── POST /v2/*/upload    ❌ 不支持 multipart
└── (无上传工具)               ❌ 不存在
```

## 二、数据流对比

### 2.1 理想流程（不可行）

```
账号2 MCP                    本地处理                    账号1 MCP
────────                    ────────                    ────────
get_topic_info  →  images[] → download → upload → 得到新 image_ids
                 files[]   → download → upload → 得到新 file_ids
                                                          ↓
                                                    create_topic(image_ids, file_ids)
                                                          ✅
```

断裂点在 `upload` 环节——不存在此 API。

### 2.2 实际可行流程

```
账号2 MCP                    本地处理                    账号1 MCP
────────                    ────────                    ────────
get_topic_info  →  title
                 content
                 hashtags (从 content 解析)
                                            →  create_topic(title, content)
                                            →  set_topic_tags(...)
                                                          ✅
```

## 三、无法绕过图片 ID 的原因

### 3.1 `create_topic` 不接收 URL

尝试在 content 中嵌入 Markdown 图片语法 `![](https://images.zsxq.com/xxx)`：

```json
// 测试：把图片 URL 写入 content
{
  "group_id": "88882114281542",
  "title": "测试",
  "content": "文字内容 ![](https://images.zsxq.com/Fxxx?xxx)",
  "image_ids": [],
  "file_ids": []
}
```

**结果**：图片不会渲染。知识星球的图片系统基于 `image_id`，content 中的 Markdown 图片语法不会被服务端解析为附件。

### 3.2 CDN URL 无法跨账号复用

账号2的图片 CDN URL 格式：
```
https://images.zsxq.com/FpYcgXLM2sJ9qFXsHUr9Ko0kA6aY?e=1785513599&token=...
```

- URL 包含有效期参数 `e=时间戳`
- URL 包含鉴权参数 `token=...`
- 这些 token 可能绑定到原始上传账号的上下文
- 即使 URL 暂时可访问，也无法作为 `image_ids` 引用

## 四、潜在替代方案及其局限性

| 方案 | 可行性 | 阻塞原因 |
|------|:------:|----------|
| MCP `call_zsxq_api` 上传 | ❌ | 不支持 multipart body |
| 直连 API + Cookie 上传 | ❌ | 上传端点 404，不存在公开接口 |
| content 嵌入图片 URL | ❌ | zsxq 不解析 Markdown 图片语法 |
| 复用账号2的 image_ids | ❌ | image_id 有星球作用域隔离 |
| 浏览器自动化上传 | ⚠️ | 需登录态 + 反爬，不可靠 |
| 联系星主开通 Skill 权限 | ⚠️ | 不解决上传 API 缺失问题 |

## 五、结论

| 内容类型 | 可搬运 | 搬运方式 |
|----------|:------:|----------|
| 纯文字帖子 | ✅ | 标题 + 内容直搬 |
| 帖子标签 | ✅ | `set_topic_tags` 打标 |
| 带图片帖子 | ❌ | 需跳过或仅搬文字 |
| 带附件帖子 | ❌ | 需跳过或仅搬文字 |

**纯 MCP 方案无法搬运图片/文件的根本原因**：知识星球对普通开发者暴露的 API 是半开放的——读操作（查询、下载链接）公开可用，但写操作中的文件上传链路未通过 API 暴露，仅在客户端内部闭环实现。这是平台侧的设计限制，不属于 CLI/MCP 工具的能力边界。
