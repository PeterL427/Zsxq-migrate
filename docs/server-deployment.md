# 服务器部署全流程指南

> zsxq 跨账号迁移项目从零部署到服务器，24x7 定时运行。

---

## 一、前提：本地准备

### 1.1 确保项目已推送到 Git

```bash
cd ~/Desktop/zsxq_test

# config.json 等敏感文件已在 .gitignore
git init
git add .
git commit -m "zsxq 跨账号迁移项目"
git remote add origin git@github.com:your-username/zsxq_test.git
git push -u origin main
```

### 1.2 哪些文件已忽略（不走 Git）

| 文件/目录 | 原因 |
|------|------|
| `config.json` | 含 MCP API Key、Cookie、IMA 凭证 |
| `.playwright-profile/` | 浏览器登录会话 |
| `.playwright-debug/` | 调试截图 |
| `migrate-record.json` | 迁移记录 |
| `migrate-failed.json` | 失败记录 |
| `ima-account-state.json` | IMA 多账号轮换状态 |
| `downloads/`、`downloads-fetch/` | 下载文件 |
| `node_modules/` | npm 依赖 |

### 1.3 桌面端生成认证文件

**这些文件不上传 Git，需要单独 scp 到服务器。**

```bash
# 步骤 1：确认 config.json 已配置
cat config.json
# → profiles.fetch.mcpApiKey   = "cde5fe..."   (源账号，读取用)
# → profiles.upload.mcpApiKey  = "6b38c7..."   (目标账号，发布用)
# → ima.accounts[]             = [{clientId, apiKey}, ...]  (IMA 上传凭证)
# → ima.knowledgeBaseId        = "1ACD5..."    (IMA 知识库 ID)
# → ima.tagFolderMap           = { "#tag#": "folder_xxx", ... }  (tag→文件夹映射)

# 步骤 2：桌面端登录 Playwright（生成浏览器会话）
node scripts/publish-pw.mjs --login
# 浏览器弹出 → 扫码/手机号登录 zsxq → 看到"登录成功"后关闭
# 生成 .playwright-profile/ 目录
```

### 1.4 打包敏感文件（不上传 Git）

```bash
# 把需要手动传输的文件打包
tar -czf deploy-secrets.tar.gz \
  config.json \
  .playwright-profile/

# 这个压缩包 scp 到服务器，不上传 Git
```

---

## 二、服务器选型

### 2.1 最低配置

| 资源 | 需求 | 说明 |
|------|:----:|------|
| CPU | 2 核 | Node.js + Playwright Chromium |
| 内存 | 2 GB | Chromium ~500MB，Node ~200MB |
| 磁盘 | 5 GB | 项目 + Playwright 400MB + 日志 |
| 系统 | Ubuntu 22.04 / Debian 12 | x86_64 或 ARM64 均可 |

### 2.2 免费方案

| 厂商 | 方案 | 配置 | 评价 |
|------|------|------|------|
| **Oracle Cloud** ⭐ | Always Free Tier | 4 核 ARM / 24GB / 200GB | **唯一免费够用的**，需信用卡验证不扣费 |
| Google Cloud | Free Tier | 1 核 / 1GB / 30GB | 内存太小，Playwright 吃力 |
| Azure | 免费 12 个月 | 1 核 / 1GB | 同上 |

### 2.3 付费方案

| 厂商 | 起步价 | 配置 |
|------|:------:|------|
| Hetzner CX22 | ~$4/月 | 2 核 / 4GB / 40GB |
| Vultr | ~$6/月 | 1 核 / 2GB / 55GB |
| DigitalOcean | ~$8/月 | 1 核 / 2GB / 50GB |
| 腾讯云轻量 | ¥50/月 | 2 核 / 2GB / 50GB |

---

## 三、服务器部署（全流程）

### 3.1 初始化环境

```bash
# SSH 登录服务器
ssh user@your-server-ip

# 更新 + 装 Node.js
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node --version  # 确认 ≥22
```

### 3.2 克隆项目

```bash
git clone git@github.com:your-username/zsxq_test.git
cd zsxq_test
```

### 3.3 安装依赖

```bash
npm install

# 安装 Chromium + 系统依赖
# --with-deps 会自动安装 libnss3、libatk-bridge 等 Linux 依赖
npx playwright install chromium --with-deps
```

### 3.4 部署认证文件

```bash
# 回到桌面端，scp 打包的敏感文件
# （在桌面 PC 上执行）
scp deploy-secrets.tar.gz user@your-server-ip:~/zsxq_test/

# 回到服务器，解压
cd ~/zsxq_test
tar -xzf deploy-secrets.tar.gz

# 验证认证文件到位
ls -la config.json .playwright-profile/
# ✅ config.json 存在
# ✅ .playwright-profile/ 存在（含登录会话）
```

### 3.5 配置 CLI 认证（zsxq-cli）

> zsxq-cli 是带文件帖的主要发布通道（CLI 原生支持 multipart 文件上传）。CLI 需要独立的 OAuth 认证，存储在系统 keychain 或文件中。

#### 方案 A：服务器直接登录（如果有显示或 X11转发）

```bash
# SSH 时带 X11 转发
ssh -X user@your-server-ip

# 直接运行
npx zsxq-cli auth login
# → 可能弹出浏览器/打印 URL → 打开扫码
# → 验证成功: npx zsxq-cli auth status
```

#### 方案 B：HOME 隔离 + 桌面登录后复制（推荐无头服务器）

**原理**：Linux 上 zsxq-cli 把认证文件存在 `$HOME/.config/zsxq-cli/`。用 `HOME` 环境变量隔离到一个独立目录，然后在任何 Linux 机器上登录后复制到服务器。

```bash
# ── 在任意带 GUI 的 Linux 机器上 ──

mkdir -p /tmp/zsxq-auth
HOME=/tmp/zsxq-auth npx zsxq-cli auth login
# → 弹出浏览器，扫码完成登录

# 查看生成的认证文件
find /tmp/zsxq-auth -type f | head -20
# 通常会有 .config/zsxq-cli/ 目录

# 打包
tar -czf zsxq-cli-auth.tar.gz -C /tmp/zsxq-auth .

# ── 传到服务器 ──
scp zsxq-cli-auth.tar.gz user@server:~/zsxq_test/

# ── 在服务器上 ──
mkdir -p .zsxq-home
tar -xzf zsxq-cli-auth.tar.gz -C .zsxq-home/
# 验证
HOME=$PWD/.zsxq-home npx zsxq-cli auth status
# → ✅ 已登录
```

然后修改守护进程启动方式，设置 `HOME`：

```bash
# PM2 启动时注入 HOME 环境变量
pm2 start scripts/daemon-migrate.mjs \
  --name migrate \
  --env HOME=/home/ubuntu/zsxq_test/.zsxq-home \
  -- --from fetch --to upload --limit 20

# 或用 systemd: 在 ExecStart 前加 Environment=
# Environment="HOME=/home/ubuntu/zsxq_test/.zsxq-home"
```

#### 方案 C：跳过 CLI，纯 Playwright 回退

不需要 CLI 认证。`migrate.mjs` 内置了降级逻辑：

```
带文件帖:
  CLI +create --files     → 尝试
  └─ 失败(missing upload_token/未登录) → Playwright 浏览器自动化
```

Playwright 回退只需要 `.playwright-profile/`（3.4 已部署），不需要额外配置。

---

### 3.6 验证认证

```bash
# 验证 MCP 连接
node -e "
import('./scripts/download-files-mcp.mjs').then(() => {
  console.log('✅ MCP 模块加载正常');
}).catch(e => console.error('❌', e.message));
"

# 验证 Playwright Profile
node -e "
import('./scripts/publish-pw.mjs').then(m => {
  console.log('✅ Playwright 模块加载正常');
  console.log('导出:', Object.keys(m).join(', '));
}).catch(e => console.error('❌', e.message));
"
```

---

## 四、启动守护进程

### 4.1 PM2 方式（推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动
pm2 start scripts/daemon-migrate.mjs \
  --name migrate \
  --node-args="" \
  -- --from fetch --to upload --limit 20

# 查看启动日志
pm2 logs migrate --lines 30

# 开机自启
pm2 startup
pm2 save
```

### 4.2 systemd 方式（备选）

```bash
sudo tee /etc/systemd/system/zsxq-migrate.service << 'EOF'
[Unit]
Description=zsxq 跨账号迁移守护进程
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/zsxq_test
ExecStart=/usr/bin/node scripts/daemon-migrate.mjs --from fetch --to upload --limit 20
Restart=always
RestartSec=10
StandardOutput=append:/home/ubuntu/zsxq_test/logs/daemon.log
StandardError=append:/home/ubuntu/zsxq_test/logs/daemon-error.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now zsxq-migrate
sudo systemctl status zsxq-migrate
```

---

## 五、认证体系总览

```
服务器上需要的认证（三种独立体系）:
────────────────────────────────────────────────────────

1. MCP API Key (config.json)
   ├── profiles.fetch.mcpApiKey   → 读取源星球主题
   ├── profiles.upload.mcpApiKey  → 发布纯文字帖、打标签
   └── 获取: zsxq 开放平台 → 创建 MCP Key

2. Playwright Profile (.playwright-profile/)
   ├── 桌面端 --login 生成，scp 到服务器
   ├── 用途: upload_token 耗尽或 CLI 失败时的浏览器回退
   └── 有效期: 通常几周，过期需桌面重新 --login

3. zsxq-cli OAuth (系统 keychain)
   ├── 用途: 带图片/附件帖的发布（唯一支持文件上传）
   ├── 桌面端: npx zsxq-cli auth login（浏览器扫码）
   ├── 服务器: 如无法直接登录，可依赖 Playwright 回退
   └── 位置: Windows Credential Manager / macOS Keychain / ~/.config/

4. IMA OpenAPI 凭证 (config.json → ima.accounts)
   ├── 用途: 带文件帖上传到腾讯 IMA 知识库
   ├── 获取: https://ima.qq.com/agent-interface → 创建 Client ID + API Key
   ├── 配置: config.json 的 ima.accounts 数组，支持多账号轮换
   ├── IMA skill 脚本: vendor/ima-skills/（项目自包含，无需额外安装）
   └── 限流: 单账号约 200 文件/天，耗尽自动切换下一账号

发布通道降级:
  带文件 → IMA 知识库上传（按 tag 分类到对应文件夹）
  纯文字 → MCP (create_topic)    → 失败 → Playwright 回退
  带图片 → CLI (+create --files)  → 失败 → Playwright 回退
```

---

## 六、运行监控

```bash
# PM2 状态
pm2 status

# 实时日志
pm2 logs migrate --lines 50

# 查看迁移记录数
wc -l migrate-record.json

# 今天日志
tail -30 logs/migrate-$(date +%F).log

# 守护进程日志
tail -50 logs/daemon.log
```

---

## 七、日常维护

| 操作 | 命令 |
|------|------|
| 停止守护进程 | `pm2 stop migrate` |
| 启动守护进程 | `pm2 start migrate` |
| 重启守护进程 | `pm2 restart migrate` |
| 彻底删除进程 | `pm2 delete migrate` |
| 更新代码 | `git pull && npm install && pm2 restart migrate` |
| Playwright 更新 | `npx playwright install chromium --with-deps` |
| Cookie 过期 | 桌面 `--login` → `scp .playwright-profile/` → `pm2 restart migrate` |
| 清理日志 | `rm logs/*.log` 或配置 `logrotate` |
| 查看失败记录 | `cat migrate-failed.json` |
| 查看 IMA 账号 | `node scripts/ima-upload.mjs --accounts` |
| 清理僵尸锁 | `rm lock/migrate.lock`（确认无进程运行后） |

### 停止进程的几种方式

```bash
# PM2 管理（推荐）
pm2 stop migrate          # 停止但保留进程配置
pm2 delete migrate        # 彻底删除进程

# 直接杀进程（非 PM2 场景）
pkill -f daemon-migrate   # 按进程名杀
pkill -f cron-migrate     # 杀单次迁移进程

# systemd 方式
sudo systemctl stop zsxq-migrate
sudo systemctl disable zsxq-migrate

# 停止后清理可能残留的锁文件
rm -f lock/migrate.lock
```

> ⚠️ 强制杀进程后，`lock/migrate.lock` 可能残留，下次启动会报"上一个实例仍在运行"。手动删除即可。

---

## 八、常见问题

### Q: 服务器无 GUI，zsxq-cli auth login 扫码怎么办？

**A:** 两种方案：
1. 用 `scp` 把桌面的 keychain 凭据同步到服务器（平台相关）
2. 不配置 CLI，依赖 Playwright 回退通道（`migrate.mjs` 内置）

### Q: Playwright cookie 多久过期？

**A:** 通常 2-4 周。监控 `pm2 logs migrate`，看到 `login-redirect` 截图即表示过期。

### Q: 内存不够怎么办？

**A:** PM2 添加 `--max-memory-restart 500M` 自动重启。Playwright 无头模式约 300-500MB。

### Q: 如何多台服务器同时跑？

**A:** 不要。`migrate-record.json` 是单点断点续传状态，多实例会导致重复发布。如需要，用独立 `config.json` 和 `migrate-record.json`。
