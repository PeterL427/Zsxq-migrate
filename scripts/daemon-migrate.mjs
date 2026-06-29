#!/usr/bin/env node
/**
 * 持久化迁移守护进程 v2.0
 *
 * 每隔指定分钟自动运行 migrate.mjs，日志实时输出到控制台 + 文件。
 * 内置锁机制（不依赖 cron-migrate 中间层），避免三层进程嵌套导致日志延迟。
 *
 * 用法:
 *   node scripts/daemon-migrate.mjs                      # 默认每 2 分钟，查看 20 条
 *   node scripts/daemon-migrate.mjs --interval 10        # 每 10 分钟
 *   node scripts/daemon-migrate.mjs --from fetch --to upload --limit 20 --interval 5
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ── 配置 ────────────────────────────────────────────────────────────────────
const args = parseArgs();
const INTERVAL_MIN = args.interval || 2;
const INTERVAL_MS = INTERVAL_MIN * 60 * 1000;

const ROOT = join(import.meta.dirname, '..');
const MIGRATE_SCRIPT = join(import.meta.dirname, 'migrate.mjs');
const LOCK_DIR = join(ROOT, 'lock');
const LOCK_FILE = join(LOCK_DIR, 'migrate.lock');
const LOG_DIR = join(ROOT, 'logs');
const TIMEOUT_MS = 8 * 60 * 1000; // 固定 8 分钟超时（与 cron-migrate 一致），锁机制防止并发

const migrateArgs = [
  MIGRATE_SCRIPT,
  '--from', args.from || 'fetch',
  '--to', args.to || 'upload',
  '--limit', String(args.limit || 20),
];

// ── 锁机制 ──────────────────────────────────────────────────────────────────

function isProcessAlive(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8', timeout: 3000 });
      return !out.includes('No tasks');
    }
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8'), 10);
      if (isProcessAlive(pid)) {
        console.log(`[${localTime()}] ⏭️  上一个实例 (PID ${pid}) 仍在运行，跳过本轮`);
        return false;
      }
      console.log(`[${localTime()}] 🧹 清理僵尸锁 (PID ${pid})`);
    } catch {}
  }
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch {}
}

// ── 运行一次迁移（异步 spawn，实时输出）────────────────────────────────────

function runMigration() {
  const start = Date.now();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`[${localTime()}] 🔄 执行迁移: --from ${args.from || 'fetch'} --to ${args.to || 'upload'} --limit ${args.limit || 20}`);

  if (!acquireLock()) return;

  const today = new Date().toISOString().slice(0, 10);
  const logFile = join(LOG_DIR, `migrate-${today}.log`);
  mkdirSync(LOG_DIR, { recursive: true });

  const child = spawn('node', migrateArgs, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let logBuffer = '';

  // 实时透传 stdout
  child.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(text);
    logBuffer += text;
  });

  // 实时透传 stderr
  child.stderr.on('data', (data) => {
    const text = data.toString();
    process.stderr.write(text);
    logBuffer += text;
  });

  // 超时保护
  const timer = setTimeout(() => {
    console.log(`\n[${localTime()}] ⏰ 超时 ${TIMEOUT_MS / 1000}s，强制终止`);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000);
  }, TIMEOUT_MS);

  child.on('close', (code) => {
    clearTimeout(timer);
    releaseLock();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const status = code === 0 ? '✅' : '❌';

    // 写入日志文件
    const logEntry = `[${localTime()}] ${code === 0 ? '✅' : '❌'} 完成 (${elapsed}s)\n${logBuffer.trim()}\n`;
    appendFileSync(logFile, logEntry);

    console.log(`\n[${localTime()}] ${status} 完成 (${elapsed}s)`);
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    releaseLock();
    console.log(`\n[${localTime()}] ❌ 进程错误: ${err.message}`);
  });
}

// ── 主循环 ──────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════╗');
console.log('║   zsxq 迁移守护进程 v2.0 (实时日志)     ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`  间隔: ${INTERVAL_MIN} 分钟 | 每批 ${args.limit || 20} 条 | ${args.from || 'fetch'} → ${args.to || 'upload'}`);
console.log(`  日志: ${join(LOG_DIR, 'migrate-YYYY-MM-DD.log')}`);
console.log(`  按 Ctrl+C 停止\n`);

// 首次立即运行
runMigration();

// 定时循环
setInterval(runMigration, INTERVAL_MS);

// Ctrl+C 优雅退出
process.on('SIGINT', () => {
  console.log('\n🛑 守护进程已停止');
  releaseLock();
  process.exit(0);
});

// ── 工具 ────────────────────────────────────────────────────────────────────
function localTime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── 参数解析 ────────────────────────────────────────────────────────────────
function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--from':     args.from = argv[++i]; break;
      case '--to':       args.to = argv[++i]; break;
      case '--limit':    args.limit = parseInt(argv[++i], 10); break;
      case '--interval': args.interval = parseInt(argv[++i], 10); break;
    }
  }
  return args;
}
