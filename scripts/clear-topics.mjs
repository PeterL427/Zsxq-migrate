#!/usr/bin/env node
/**
 * 清空指定星球的所有主题
 *
 * 用法:
 *   node scripts/clear-topics.mjs --profile upload --dry-run   # 预览
 *   node scripts/clear-topics.mjs --profile upload --limit 50  # 删除最近 50 条
 *   node scripts/clear-topics.mjs --profile upload --count 500 # 翻页删 500 条
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const CONFIG = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8')); }
  catch { console.error('❌ config.json 读取失败'); process.exit(1); }
})();

const MCP_H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

class McpClient {
  constructor(apiKey) {
    this.baseUrl = `https://mcp.zsxq.com/topic/mcp?api_key=${apiKey}`;
    this.nextId = 10;
    this.initialized = false;
  }
  async init() {
    if (this.initialized) return;
    await this._rpc('initialize', { protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{ name:'clear', version:'1.0' } });
    await fetch(this.baseUrl, { method:'POST', headers:MCP_H, body:JSON.stringify({ jsonrpc:'2.0', method:'notifications/initialized' }) });
    this.initialized = true;
  }
  async callTool(name, args = {}) {
    await this.init();
    return this._rpc('tools/call', { name, arguments: args });
  }
  async _rpc(method, params) {
    const id = this.nextId++;
    const resp = await fetch(this.baseUrl, { method:'POST', headers:MCP_H, body:JSON.stringify({ jsonrpc:'2.0', id, method, params }) });
    const text = await resp.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = JSON.parse(line.slice(6));
      if (data.error) throw new Error(`MCP ${data.error.code}: ${data.error.message}`);
      if (data.result) return data.result;
    }
    throw new Error('MCP 无响应');
  }
}

async function main() {
  const args = parseArgs();
  const profileName = args.profile || 'upload';
  const dryRun = args.dryRun;
  const perPage = Math.min(args.limit || 20, 20);
  const targetCount = args.count || args.limit || perPage;
  const paginate = args.count > 0;

  const profile = CONFIG.profiles?.[profileName];
  if (!profile) { console.error(`❌ Profile "${profileName}" 不存在`); process.exit(1); }
  if (!profile.mcpApiKey) { console.error(`❌ Profile "${profileName}" 缺少 mcpApiKey`); process.exit(1); }
  if (!profile.groupId) { console.error(`❌ Profile "${profileName}" 缺少 groupId`); process.exit(1); }

  console.log(`${dryRun ? '🔍 干跑模式' : '🗑️  删除模式'} | 星球: ${profile.groupId} | 上限: ${targetCount} 条\n`);

  const client = new McpClient(profile.mcpApiKey);

  // 收集 topic_ids
  console.log(`📋 获取主题列表（目标: ${targetCount} 条${paginate ? `，每批 ${perPage}` : ''}）...`);
  const topicIds = [];
  let endTime = '';
  let lastEndTime = '';
  let pageNum = 0;

  while (topicIds.length < targetCount) {
    pageNum++;
    const params = { group_id: profile.groupId, limit: perPage };
    if (endTime) params.end_time = endTime;

    const result = await client.callTool('get_group_topics', params);
    const list = JSON.parse(result.content[0].text);
    if (!list.success) throw new Error(list.error || '获取失败');

    const items = list.topics_brief || [];
    if (items.length === 0) break;

    for (const t of items) {
      topicIds.push({ id: t.topic_id, title: (t.title || '').slice(0, 30) });
      if (topicIds.length >= targetCount) break;
    }

    const oldest = items[items.length - 1];
    endTime = oldest?.create_time || oldest?.created_at || '';
    if (!endTime || endTime === lastEndTime) break;
    lastEndTime = endTime;

    if (paginate) {
      console.log(`  第 ${pageNum} 页: ${items.length} 条，累计: ${topicIds.length}`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!paginate) break;
  }

  console.log(`  待删除: ${topicIds.length} 条\n`);
  if (topicIds.length === 0) { console.log('没有主题，退出。'); process.exit(0); }

  // 逐条删除
  let deleted = 0, failed = 0;
  for (let i = 0; i < topicIds.length; i++) {
    const { id, title } = topicIds[i];
    console.log(`[${i+1}/${topicIds.length}] 🗑️  ${id}  ${title}`);

    if (dryRun) { deleted++; continue; }

    try {
      const delResult = await client.callTool('call_zsxq_api', {
        method: 'DELETE',
        path: `/v2/topics/${id}`,
      });
      const delData = JSON.parse(delResult.content[0].text);
      const ok = delData.succeeded || delData.body?.resp_data?.succeeded || delData.body?.succeeded;
      if (ok) {
        console.log(`   ✅ 已删除`);
        deleted++;
      } else {
        console.log(`   ⚠️  返回: ${JSON.stringify(delData).slice(0, 80)}`);
        failed++;
      }
    } catch (e) {
      console.log(`   ❌ ${e.message.slice(0, 80)}`);
      failed++;
    }

    if (i < topicIds.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`📊 汇总`);
  console.log(`${'='.repeat(40)}`);
  console.log(`  删除: ${deleted}`);
  console.log(`  失败: ${failed}`);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = { dryRun: false, limit: 20, count: 0, profile: 'upload' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--profile': args.profile = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      case '--limit':   args.limit = parseInt(argv[++i], 10); break;
      case '--count':   args.count = parseInt(argv[++i], 10); break;
      case '--help': case '-h':
        console.log(`清空星球主题

用法:
  node scripts/clear-topics.mjs --profile upload --dry-run   # 预览
  node scripts/clear-topics.mjs --profile upload --limit 20  # 删 20 条
  node scripts/clear-topics.mjs --profile upload --count 500 # 翻页删 500 条`);
        process.exit(0);
    }
  }
  return args;
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
