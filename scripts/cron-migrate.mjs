#!/usr/bin/env node
/**
 * cron 定时迁移包装脚本 v1.0
 *
 * 每 10 分钟被调度调用，调用 migrate.mjs 执行迁移，
 * 输出日志到 ../logs/，锁文件防止并发。
 *
 * 用法:
 *   node scripts/cron-migrate.mjs --from fetch --to upload --limit 10
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 路径 ────────────────────────────────────────────────────────────────────
const ROOT = join(import.meta.dirname, '..');
const LOCK_DIR = join(ROOT, 'lock');
const LOCK_FILE = join(LOCK_DIR, 'migrate.lock');
const LOG_DIR = join(ROOT, 'logs');
const MIGRATE_SCRIPT = join(import.meta.dirname, 'migrate.mjs');
const TIMEOUT_MS = 8 * 60 * 1000; // 8 分钟超时，留 2 分钟余量给 cron 间隔

// ── 参数解析 ────────────────────────────────────────────────────────────────
const args = parseArgs();
const from = args.from || 'fetch';
const to = args.to || 'upload';
const limit = args.limit || 10;

// ── 锁检查 ──────────────────────────────────────────────────────────────────
if (existsSync(LOCK_FILE)) {
  // 检查是否为僵尸锁（PID 已不存在）
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8'), 10);
    if (isProcessAlive(pid)) {
      console.log(`[${timestamp()}] 上一个实例 (PID ${pid}) 仍在运行，跳过本次`);
      process.exit(0);
    }
    console.log(`[${timestamp()}] 清理僵尸锁 (PID ${pid})`);
  } catch {}
}

mkdirSync(LOCK_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(LOCK_FILE, String(process.pid));

// ── 执行迁移 ────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const logFile = join(LOG_DIR, `migrate-${today}.log`);

console.log(`[${timestamp()}] 开始定时迁移: --from ${from} --to ${to} --limit ${limit}`);

let ok = false;
try {
  const cmd = `node "${MIGRATE_SCRIPT}" --from ${from} --to ${to} --limit ${limit}`;
  const stdout = execSync(cmd, {
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const log = `[${timestamp()}] ✅ 完成\n${stdout.trim()}\n`;
  appendFileSync(logFile, log);
  console.log(stdout.trim());
  ok = true;
} catch (err) {
  const stdout = err.stdout || '';
  const stderr = err.stderr || '';
  const log = `[${timestamp()}] ❌ 失败\nstderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 500)}\n`;
  appendFileSync(logFile, log);
  console.error(`❌ 迁移异常: ${err.message}`);
} finally {
  try { unlinkSync(LOCK_FILE); } catch {}
}

process.exit(ok ? 0 : 1);

// ── 工具 ────────────────────────────────────────────────────────────────────
function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 检查进程是否存在（仅 Windows / Linux） */
function isProcessAlive(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8', timeout: 3000 });
      // tasklist 找不到进程时返回 "INFO: No tasks..." 而不是抛异常
      return !out.includes('No tasks');
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--from':  args.from = argv[++i]; break;
      case '--to':    args.to = argv[++i]; break;
      case '--limit': args.limit = parseInt(argv[++i], 10); break;
    }
  }
  return args;
}
