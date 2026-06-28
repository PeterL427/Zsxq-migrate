#!/usr/bin/env node
/**
 * 持久化迁移守护进程
 *
 * 每隔指定分钟自动运行 migrate.mjs，日志输出到控制台 + 文件。
 * 使用 cron-migrate.mjs 的锁机制防止并发。
 *
 * 用法:
 *   node scripts/daemon-migrate.mjs                      # 默认每 2 分钟，查看 20 条
 *   node scripts/daemon-migrate.mjs --interval 10        # 每 10 分钟
 *   node scripts/daemon-migrate.mjs --from fetch --to upload --limit 20 --interval 5
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// ── 配置 ────────────────────────────────────────────────────────────────────
const args = parseArgs();
const INTERVAL_MIN = args.interval || 2;
const INTERVAL_MS = INTERVAL_MIN * 60 * 1000;

const CRON_SCRIPT = join(import.meta.dirname, 'cron-migrate.mjs');
const cronArgs = [
  '--from', args.from || 'fetch',
  '--to', args.to || 'upload',
  '--limit', String(args.limit || 20),
];

// ── 运行一次迁移 ────────────────────────────────────────────────────────────
function runMigration() {
  const start = Date.now();
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`[${localTime()}] 🔄 执行迁移...`);

  const result = spawnSync('node', [CRON_SCRIPT, ...cronArgs], {
    encoding: 'utf-8',
    timeout: INTERVAL_MS - 30000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // 透传子进程输出
  if (result.stdout) {
    // 跳过 cron-migrate 自己的时间戳头，直接展示 migrate 的详细输出
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      if (line.startsWith('[') && line.includes('开始定时迁移')) continue;
      if (line.trim()) console.log(line);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`[${localTime()}] ✅ 完成 (${elapsed}s)`);
  } else {
    console.log(`[${localTime()}] ❌ 失败 (${elapsed}s)`);
    if (result.stderr) console.log(result.stderr.slice(0, 300));
  }
}

// ── 主循环 ──────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════╗');
console.log('║   zsxq 迁移守护进程 v1.0             ║');
console.log('╚══════════════════════════════════════╝');
console.log(`  间隔: ${INTERVAL_MIN} 分钟 | 每批 ${args.limit || 20} 条 | ${args.from || 'fetch'} → ${args.to || 'upload'}`);
console.log(`  按 Ctrl+C 停止\n`);

// 首次立即运行
runMigration();

// 定时循环
setInterval(runMigration, INTERVAL_MS);

// Ctrl+C 优雅退出
process.on('SIGINT', () => {
  console.log('\n🛑 守护进程已停止');
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
