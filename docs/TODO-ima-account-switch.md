# 待测试：IMA 多账号轮换

> 状态：**部分验证（2026-06-29 13:02）** — IMA 账号轮换已验证通过；zsxq MCP 下载限流仍未恢复，完整迁移流程受阻。

---

## 背景

2026-06-29 凌晨实测 `cron-migrate.mjs --limit 20`，13 条带文件帖全部失败：
- `请求频率超限，请稍后重试`
- `请求超量，请明日再试`

发现 `shouldSwitchAccount` 没匹配到这些中文错误消息，一直用 account1 重试，未切换 account2。

## 已修复（未提交）

**文件**：`scripts/ima-upload.mjs`

1. `shouldSwitchAccount` 关键词新增：`超限|超量|频率|稍后重试|明日再试` — **已验证生效**
2. 切换账号后加 2s 等待

```js
// 修复前
if (/频控|限制|limit|quota|rate|exceed|too many|throttl/.test(msg)) return true;

// 修复后
if (/频控|限制|limit|quota|rate|exceed|too many|throttl|超限|超量|频率|稍后重试|明日再试/.test(msg)) return true;
```

## 待验证项

### 1. account1 限流 → 自动切换 account2 ✅ 已验证（2026-06-29）

**验证方式**：直接用本地文件 `downloads/22255244441454551_大摩-藤仓.pdf` 调用 ima-upload.mjs CLI

**实际日志**：
```
🔍 preflight-check... [账号: account1]
📄 22255244441454551_大摩-藤仓.pdf (3.68MB, type=1)
📤 上传中 [账号: account1]...
⚠️  账号 account1 失败: 账号account1受限: 请求超量，请明日再试
🔄 切换到账号: account2
🔍 preflight-check... [账号: account2]
📤 上传中 [账号: account2]...
✅ 已上传: 22255244441454551_大摩-藤仓.pdf [账号: account2]
```

`shouldSwitchAccount` 修复确认生效（正确匹配"超量""明日再试"）。

### 2. 两个账号都限流 → 停止上传

⏳ 未测试（account2 仍有额度，无法触发双账号限流场景）

### 3. 活跃账号状态持久化 ✅ 已验证（2026-06-29）

account2 成功上传后，`ima-account-state.json` 已更新：
```json
{
  "activeIndex": 1,
  "accountName": "account2",
  "updatedAt": "2026-06-29T05:02:16.233Z"
}
```

### 4. zsxq MCP 下载限流恢复 ❌ 仍未恢复（2026-06-29）

cron-migrate 实测 5 条（13:01）：
- 3 条文字/图片帖 → CLI 发布成功
- 2 条带文件帖 → `附件1 下载链接为空` → 无文件可传，跳过 IMA 上传

zsxq MCP 下载限流为**日级**（距 6/28 17:12 已过 ~20 小时仍未恢复），需等 6/30 恢复后重测完整流程。

## 测试步骤

1. ~~等待次日 IMA 额度恢复~~ — account1 仍限流（日级），正好用于测试切换
2. ⏳ 提交 `ima-upload.mjs` 的修复（待用户确认）
3. ✅ 跑 `node scripts/ima-upload.mjs --accounts` 确认 2 个账号
4. ✅ 跑 `node scripts/cron-migrate.mjs --from fetch --to upload --limit 5`（文字/图片成功，带文件帖因 zsxq MCP 限流失败）
5. ✅ 直接用本地文件测 IMA 上传，确认 account1→account2 切换生效
6. ✅ 确认 `ima-account-state.json` 持久化 activeIndex=1

## 风险点

- **zsxq MCP 下载限流**：如果 zsxq 端也日级限流，带文件帖的附件无法下载，IMA 上传流程无法启动
- **IMA 限流粒度**：目前只知道约 200 文件/天，不确定是按文件数还是按 API 调用次数
- **多账号同知识库**：两个账号上传到同一知识库，重名检查可能互相影响
