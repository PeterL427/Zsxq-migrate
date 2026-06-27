# zsxq-cross-group-sync

知识星球跨星球主题同步工具。从源星球自动搬运主题（文字、图片、附件）到目标星球，支持定时守护进程。

## 快速开始

```bash
# 1. 安装依赖
npm install
npx playwright install chromium

# 2. 配置 config.json（按 config.example.json 模板填写）
#    两个 profile：fetch（源星球）+ upload（目标星球）
#    每个 profile 需要 mcpApiKey 和 cookie

# 3. Playwright 登录（用于文件上传容灾）
node scripts/publish-pw.mjs --login

# 4. 预览
node scripts/migrate.mjs --from fetch --to upload --dry-run

# 5. 迁移
node scripts/migrate.mjs --from fetch --to upload --limit 10

# 6. 守护进程（每 5 分钟自动同步）
npm run daemon
```

## 架构

```
源星球                       本地处理                  目标星球
MCP API                      下载 + 转换               MCP / CLI / Playwright
┌──────────┐            ┌──────────┐            ┌──────────┐
│ 读取层    │──topic──→  │ 下载层    │──文件──→   │ 发布层    │
│ MCP      │──tag───→ ──────────────────────→   │ MCP      │
└──────────┘            │ HTTP CDN │            │ CLI      │
                        └──────────┘            │ PW 回退  │
                                                └──────────┘
```

## 发布通道降级

```
带文件帖:
  CLI topic +create --files     → 主通道
  └─ 失败(missing upload_token) → Playwright 浏览器自动化

纯文字帖:
  MCP create_topic              → 主通道（换行正确）
  └─ 失败                       → Playwright 浏览器自动化
```

## 脚本

| 脚本 | 用途 |
|------|------|
| `scripts/migrate.mjs` | 跨星球迁移主脚本 |
| `scripts/daemon-migrate.mjs` | 持久化守护进程（5 分钟/轮） |
| `scripts/cron-migrate.mjs` | 单次定时任务（带锁 + 日志） |
| `scripts/publish-pw.mjs` | Playwright 浏览器发帖模块 |
| `scripts/download-files.mjs` | CLI 版文件下载 |
| `scripts/download-files-mcp.mjs` | MCP 版文件下载（零依赖） |

## 配置示例

```jsonc
// config.json
{
  "profiles": {
    "fetch": {
      "mcpApiKey": "源星球 MCP Key",
      "cookie": "源星球 Cookie",
      "groupId": "源星球 ID"
    },
    "upload": {
      "mcpApiKey": "目标星球 MCP Key", 
      "cookie": "目标星球 Cookie",
      "groupId": "目标星球 ID"
    }
  }
}
```

## 文档

- [跨星球迁移计划](docs/cross-account-migration-plan.md)
- [Playwright 回退方案](docs/playwright-fallback-plan.md)
- [MCP 文件上传局限性](docs/cross-account-file-limitation.md)
- [服务器部署指南](docs/server-deployment.md)
