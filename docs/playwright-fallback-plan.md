# Playwright 回退上传方案 ✅ 已实现

> **目标**：CLI 文件上传 token 耗尽时，用 Playwright 浏览器自动化作为备选上传通道。
> **状态**: 核心模块已实现，待新鲜 cookie 端到端验证。

## 当前进度

### ✅ 已完成

1. **`scripts/publish-pw.mjs` v2.0 — Playwright 浏览器自动化发帖模块**
   - 导出 `publishViaPlaywright()` 函数，可被 `migrate.mjs` 导入
   - 支持命令行独立运行和模块导入两种模式
   - 多策略选择器：编辑器、文件上传、提交按钮均有降级后备
   - Cookie 过期自动检测并截图报告
   - 交互模式 `--interactive`：手动发帖 + 捕获 API 请求（用于逆向分析）
   - 有头模式 `--headed`：可视化调试

2. **`migrate.mjs` 集成 Playwright fallback**
   - `publishWithFiles` 失败时（`missing upload_token` 或其他错误）→ 自动回退 `publishViaPlaywright`
   - `publishTextOnly` 失败时也尝试 Playwright 回退
   - 从 `config.json` 自动读取目标账号 cookie

3. **playwright-cli 环境搭建**
   - 已安装 `@playwright/cli` 全局工具
   - 可用于交互式探索页面元素、调试选择器

### 命令速查

```bash
# 独立使用
node scripts/publish-pw.mjs --text "帖子正文" --files "a.jpg,b.pdf"

# 交互模式（捕获 API 请求）
node scripts/publish-pw.mjs --interactive --headed

# 有头调试
node scripts/publish-pw.mjs --text "测试" --headed --group-id 888...

# 迁移脚本自动回退（无需额外配置）
node scripts/migrate.mjs --from fetch --to upload --limit 10
```

### ⚠️ 前提条件

- **需要有效的浏览器 cookie**：cookie 过期后会被重定向到登录页，模块会检测并报告
- cookie 存储在 `config.json` → `profiles.upload.cookie`
- 获取新鲜 cookie：浏览器登录 wx.zsxq.com → F12 → Application → Cookies → 复制 `zsxq_access_token`

## 模块架构

### `publishViaPlaywright()` 函数

```js
import { publishViaPlaywright } from './scripts/publish-pw.mjs';

const { topicId, error } = await publishViaPlaywright({
  text: '帖子正文',          // 必填
  filePaths: ['a.jpg'],      // 可选，本地文件路径
  cookie: 'zsxq_access_token=...',  // 从 config.json 获取
  groupId: '88882114281542',     // 目标星球
  headless: true,               // 无头/有头模式
  interactive: false,           // 交互模式（捕获 API 请求）
  timeout: 60000,               // 总超时
});
```

### 流程

```
publishViaPlaywright()
├── 1. 启动 Chromium（注入 cookie + 反检测 UA）
├── 2. 导航星球首页 → 检测 cookie 是否有效（是否被重定向到登录页）
├── 3. 打开发帖页
├── 4. 多策略查找编辑器 → 填入正文
├── 5. 上传文件（3 种策略降级）
│   ├── 策略 A: 直接 setInputFiles（input[type=file] 已存在）
│   ├── 策略 B: 触发文件选择器 → waitForEvent('filechooser')
│   └── 策略 C: JS 注入（最后手段）
├── 6. 多策略查找提交按钮 → 点击发布
├── 7. 提取 topic_id（URL 匹配 / 页面内容匹配）
└── 8. 截图保存 → 关闭浏览器 → 返回结果
```

### migrate.mjs 集成

```js
// 文件帖：CLI → 失败 → Playwright 回退
try {
  newId = publishWithFiles(content, localFiles);
} catch (cliErr) {
  // upload_token 耗尽 或 CLI 其他错误
  const pwResult = await publishViaPlaywright({...});
  newId = pwResult.topicId;
}

// 纯文字帖：MCP → 失败 → Playwright 回退
try {
  newId = await publishTextOnly(tagger, content);
} catch (mcpErr) {
  const pwResult = await publishViaPlaywright({...});
  newId = pwResult.topicId;
}
```

## 相关文件

- `scripts/publish-pw.mjs` — Playwright 发帖模块 v2.0（主模块）
- `scripts/migrate.mjs` — 已集成 Playwright fallback
- `config.json` — `profiles.{name}.cookie` 提供认证
- `.playwright-debug/` — 调试截图自动保存于此

## 已知限制

- Playwright 浏览器启动有冷启动成本（~2-3s）
- Cookie 需保持新鲜（过期会被重定向到登录页，模块会检测并报错）
- 知识星球前端页面结构可能变动（多策略选择器降级可缓解）
- Windows 上 HOME 隔离方案不生效（keyring 不走 HOME）
