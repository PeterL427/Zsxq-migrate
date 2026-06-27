import { execSync } from 'child_process';

const B = 'https://mcp.zsxq.com/topic/mcp?api_key=6b38c7639b3d947859311f520ba76447';
const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
let n = 1;
async function call(m, p) {
  const r = await fetch(B, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: n++, method: m, params: p || {} }) });
  const t = await r.text();
  for (const l of t.split('\n')) {
    if (!l.startsWith('data:')) continue;
    const d = JSON.parse(l.slice(6));
    if (d.result) return d.result;
  }
}

(async () => {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1.0' } });
  await fetch(B, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const r = await call('tools/call', { name: 'get_group_topics', arguments: { group_id: '88882114281542', limit: 15 } });
  const list = JSON.parse(r.content[0].text);

  // 删除最近 12 条（迁移帖在最顶部）
  const toDelete = list.topics_brief.slice(0, 12);
  console.log('将删除', toDelete.length, '条');
  for (const t of toDelete) {
    try {
      execSync(`npx zsxq-cli api raw --method DELETE --path /v2/topics/${t.topic_id}`, {
        encoding:'utf-8', timeout:15000, stdio:['pipe','pipe','pipe'],
      });
      console.log('✅', t.topic_id);
    } catch (e) {
      console.log('❌', t.topic_id, e.stderr?.slice(0, 60) || e.message.slice(0, 60));
    }
  }
})();
