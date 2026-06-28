#!/usr/bin/env node
/**
 * zsxq 跨账号主题迁移脚本 v2.0
 *
 * 从 config.json 的 profiles 中读取源/目标账号配置，
 * 通过 --from / --to 指定 profile 名称即可。
 *   fetch  = 抓取账号（源），upload = 上传账号（目标）
 *
 * 用法:
 *   node scripts/migrate.mjs --from fetch --to upload --dry-run
 *   node scripts/migrate.mjs --from fetch --to upload --limit 10
 *   node scripts/migrate.mjs --from fetch --to upload --resume
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { publishViaPlaywright } from './publish-pw.mjs';

// ── 配置 ────────────────────────────────────────────────────────────────────

const CONFIG = (() => {
  try { return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config.json'), 'utf-8')); }
  catch { console.error('❌ config.json 读取失败'); process.exit(1); }
})();

/** 从 config.json profiles 中解析源/目标账号 */
function resolveProfile(name) {
  const profiles = CONFIG.profiles;
  if (!profiles) {
    console.error('❌ config.json 中缺少 profiles 字段');
    process.exit(1);
  }
  const p = profiles[name];
  if (!p) {
    console.error(`❌ Profile "${name}" 不存在，可用: ${Object.keys(profiles).join(', ')}`);
    process.exit(1);
  }
  if (!p.mcpApiKey) {
    console.error(`❌ Profile "${name}" 缺少 mcpApiKey`);
    process.exit(1);
  }
  if (!p.groupId) {
    console.error(`❌ Profile "${name}" 缺少 groupId`);
    process.exit(1);
  }
  return { mcpKey: p.mcpApiKey, groupId: p.groupId, name };
}

// SRC / DST 由命令行参数 --from / --to 动态解析
let SRC, DST;

const TEMP_DIR = join(import.meta.dirname, '..', 'migrate-temp');
const RECORD_FILE = join(import.meta.dirname, '..', 'migrate-record.json');
const FAILED_FILE = join(import.meta.dirname, '..', 'migrate-failed.json');
const MCP_H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

// ── MCP 客户端 ──────────────────────────────────────────────────────────────

class McpClient {
  constructor(apiKey) {
    this.baseUrl = `https://mcp.zsxq.com/topic/mcp?api_key=${apiKey}`;
    this.nextId = 10;
    this.initialized = false;
  }
  async init() {
    if (this.initialized) return;
    await this._rpc('initialize', { protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{ name:'migrate', version:'1.0' } });
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

// ── 图片来源 ────────────────────────────────────────────────────────────────

function getImageUrl(img) {
  if (typeof img === 'string') return img;
  if (img.original?.url) return img.original.url;
  if (img.large?.url) return img.large.url;
  if (img.url) return img.url;
  return null;
}

function getImageExt(img) {
  const t = (img.type || '').toLowerCase();
  const map = { png:'.png', jpg:'.jpg', jpeg:'.jpg', gif:'.gif', webp:'.webp', bmp:'.bmp', svg:'.svg' };
  return map[t] || '.jpg';
}

// ── 标签解析 ────────────────────────────────────────────────────────────────

function parseHashtags(content) {
  const tags = [];
  const regex = /<e\s+type="hashtag"[^>]*title="([^"]+)"[^>]*\/>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]); // %23xxx%23 → #xxx#
      tags.push(decoded);
    } catch { tags.push(match[1]); }
  }
  return [...new Set(tags)];
}

// ── 文件下载 ────────────────────────────────────────────────────────────────

async function downloadFile(url, destPath) {
  if (existsSync(destPath)) return;
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(destPath);
    const getFn = url.startsWith('https') ? httpsGet : httpGet;
    getFn(url, { timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        stream.close();
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { stream.close(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      res.pipe(stream);
      stream.on('finish', resolve);
      stream.on('error', (e) => { stream.close(); reject(e); });
    }).on('error', (e) => { stream.close(); reject(e); });
  });
}

// ── 发布（CLI） ─────────────────────────────────────────────────────────────

/** 纯文字帖：用 MCP create_topic（JSON 天然支持真实换行） */
async function publishTextOnly(client, content) {
  const result = await client.callTool('create_topic', {
    group_id: DST.groupId,
    title: '',           // 留空，内容第一行即标题
    content,             // 直接传内容，\\n 会被 JSON 解析为真实换行
    image_ids: [],
    file_ids: [],
  });
  const data = JSON.parse(result.content[0].text);
  return data.success ? data.topic?.topic_id : null;
}

/** 带文件帖：用 CLI topic +create --files（直接调原生二进制，跨平台无需 shell） */
function publishWithFiles(content, filePaths) {
  const filesArg = filePaths.map(p => p.replace(/\\/g, '/')).join(',');
  // 找 zsxq-cli 原生二进制（非 shell wrapper）
  const binDir = join(import.meta.dirname, '..', 'node_modules', '@zsxq');
  let cliBin = '';
  for (const dir of [join(binDir, 'cli-win32-x64', 'bin', 'zsxq-cli.exe'),
                      join(binDir, 'cli-linux-x64', 'bin', 'zsxq-cli'),
                      join(binDir, 'cli-linux-arm64', 'bin', 'zsxq-cli'),
                      join(binDir, 'cli-darwin-arm64', 'bin', 'zsxq-cli'),
                      join(binDir, 'cli-darwin-x64', 'bin', 'zsxq-cli')]) {
    if (existsSync(dir)) { cliBin = dir; break; }
  }
  if (!cliBin) throw new Error('找不到 zsxq-cli 原生二进制，请确认已安装 zsxq-cli');

  const result = spawnSync(cliBin, [
    'topic', '+create',
    '--group-id', DST.groupId,
    '--text', content,
    '--files', filesArg,
    '--json',
  ], {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();

  if (result.error) {
    throw new Error(`CLI 执行失败: ${result.error.message}\nstderr: ${stderr.slice(0, 200)}`);
  }
  if (result.status !== 0) {
    throw new Error(`CLI 退出码 ${result.status}\nstderr: ${stderr.slice(0, 200)}`);
  }

  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) throw new Error(`发布返回无 JSON\nstdout: ${stdout.slice(0, 200)}\nstderr: ${stderr.slice(0, 200)}`);

  const data = JSON.parse(stdout.slice(jsonStart));
  return data.success ? data.topic?.topic_id : null;
}

// ── 记录管理 ────────────────────────────────────────────────────────────────

function loadRecord() {
  try { return JSON.parse(readFileSync(RECORD_FILE, 'utf-8')); } catch { return {}; }
}
function saveRecord(rec) {
  writeFileSync(RECORD_FILE, JSON.stringify(rec, null, 2));
}
function loadFailed() {
  try { return JSON.parse(readFileSync(FAILED_FILE, 'utf-8')); } catch { return []; }
}
function saveFailed(list) {
  writeFileSync(FAILED_FILE, JSON.stringify(list, null, 2));
}

// ── 重试工具 ────────────────────────────────────────────────────────────────

/** MCP 调用重试：MCP 无响应时最多重试 maxRetries 次 */
async function retryCall(fn, maxRetries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < maxRetries && err.message === 'MCP 无响应') {
        console.log(`     🔄 MCP 无响应，${delayMs / 1000}s 后重试 (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const dryRun = args.dryRun;
  const limit = args.limit || 10;
  const resume = args.resume;

  // 从 profiles 解析源/目标账号
  SRC = resolveProfile(args.from);
  DST = resolveProfile(args.to);

  const record = loadRecord();
  let failed = resume ? loadFailed() : [];
  // 用 Set 快速判断哪些是之前失败的（用于成功后清除）
  const failedSet = new Set(failed.map(f => f.sourceId));
  const migrated = new Set(Object.keys(record));
  // 不要将 failed 加入 migrated，否则它们会被跳过无法重试

  // 计算翻页参数
  const perPage = Math.min(limit, 20); // API 单次上限
  const targetCount = args.count || limit; // --count 指定总数，否则取单页 limit
  const paginate = args.count > 0; // 翻页模式

  // 创建临时目录
  if (!dryRun) {
    if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive:true });
    mkdirSync(TEMP_DIR, { recursive:true });
  }

  console.log(`${dryRun ? '🔍 干跑模式' : '🚀 正式迁移'} | 源: ${SRC.name}(${SRC.groupId}) → 目标: ${DST.name}(${DST.groupId}) | 上限: ${targetCount}条\n`);

  // 1. 连接抓取账号 MCP 读取主题（支持翻页）
  const reader = new McpClient(SRC.mcpKey);

  console.log(`📋 [1/4] 获取主题列表（目标: ${targetCount} 条${paginate ? `，每批 ${perPage} 条` : ''}）...`);

  const topicIds = [];
  let endTime = '';
  let lastEndTime = '';
  let pageNum = 0;

  while (topicIds.length < targetCount) {
    pageNum++;
    const params = { group_id: SRC.groupId, limit: perPage };
    if (endTime) params.end_time = endTime;

    const listResult = await reader.callTool('get_group_topics', params);
    const list = JSON.parse(listResult.content[0].text);
    if (!list.success && list.error) throw new Error(list.error);

    const items = list.topics_brief || [];
    if (items.length === 0) break; // 没有更多了

    for (const t of items) {
      if (migrated.has(t.topic_id)) continue;
      if (t.type === 'q&a') { console.log(`  ⏭️  ${t.topic_id} — Q&A 跳过`); continue; }
      topicIds.push(t.topic_id);
      if (topicIds.length >= targetCount) break;
    }

    // 下一页游标：用最后一条的创建时间
    const oldest = items[items.length - 1];
    endTime = oldest?.create_time || oldest?.created_at || '';
    if (!endTime || endTime === lastEndTime) break; // 无法继续翻页
    lastEndTime = endTime;

    if (paginate) {
      console.log(`  第 ${pageNum} 页: ${items.length} 条，累计待处理: ${topicIds.length}`);
      await new Promise(r => setTimeout(r, 2000)); // 翻页间隔
    }

    if (!paginate) break; // 非翻页模式，一页就停
  }

  console.log(`  待处理: ${topicIds.length} 条\n`);

  // 反转处理顺序：源星球 API 返回最新在前，收集顺序为新→旧。
  // 反转后变为旧→新，最旧的先发，最新的最后发 → 最新帖出现在目标星球顶部，与源星球顺序一致。
  topicIds.reverse();

  if (topicIds.length === 0) {
    console.log('没有待处理的主题，退出。');
    process.exit(0);
  }

  // 2. 连接上传账号 MCP 用于打标签
  const tagger = dryRun ? null : new McpClient(DST.mcpKey);
  if (!dryRun) await tagger.init();

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  // 3. 逐条处理
  for (let i = 0; i < topicIds.length; i++) {
    const srcId = topicIds[i];
    const prefix = `[${i+1}/${topicIds.length}]`;
    console.log(`${prefix} 📄 ${srcId}`);

    try {
      // 获取详情（自动重试 MCP 无响应）
      const detailResult = await retryCall(() => reader.callTool('get_topic_info', { topic_id:srcId }));
      const topic = JSON.parse(detailResult.content[0].text).topic;
      if (!topic) { console.log(`  ⚠️  详情为空，跳过`); failCount++; failed.push({ sourceId:srcId, error:'详情为空' }); continue; }

      const content = topic.content || topic.text || '';
      const images = topic.images || [];
      const files = topic.files || [];
      const hashtags = parseHashtags(content);
      // 带图片的帖子自动加 #图片# 标签
      if (images.length > 0 && !hashtags.includes('#图片#')) {
        hashtags.unshift('#图片#');
      }

      // 跳过纯标签帖（无实质内容）
      if (!content.trim() || (content.trim() === `<e type="hashtag"` && hashtags.length <= 1 && images.length === 0 && files.length === 0)) {
        console.log(`  ⏭️  纯标签帖，跳过`);
        skipCount++;
        record[srcId] = { newId:'skipped_tag_only', time:new Date().toISOString() };
        saveRecord(record);
        continue;
      }

      console.log(`  正文: ${content.slice(0, 50).replace(/\n/g,' ')}...`);
      if (images.length) console.log(`  图片: ${images.length} 张`);
      if (files.length) console.log(`  附件: ${files.length} 个`);
      if (hashtags.length) console.log(`  标签: ${hashtags.join(', ')}`);

      if (dryRun) {
        successCount++;
        continue;
      }

      // 3a. 下载图片
      const localFiles = [];
      if (images.length > 0) {
        console.log(`  📥 下载图片...`);
        for (let j = 0; j < images.length; j++) {
          const img = images[j];
          const url = getImageUrl(img);
          if (!url) { console.log(`     ⚠️  图片${j+1} URL 为空`); continue; }
          const ext = getImageExt(img);
          const fname = `img_${j+1}${ext}`;
          const fpath = join(TEMP_DIR, fname);
          try {
            await downloadFile(url, fpath);
            localFiles.push(fpath);
          } catch (e) { console.log(`     ❌ 下载图片${j+1} 失败: ${e.message}`); }
        }
      }

      // 3b. 下载附件
      if (files.length > 0) {
        console.log(`  📥 下载附件...`);
        for (let j = 0; j < files.length; j++) {
          const f = files[j];
          if (!f.file_id) continue;
          try {
            const dlResult = await reader.callTool('call_zsxq_api', { method:'GET', path:`/v2/files/${f.file_id}/download_url` });
            const dlData = JSON.parse(dlResult.content[0].text);
            const dlUrl = dlData.resp_data?.download_url || dlData.body?.resp_data?.download_url || '';
            if (!dlUrl) { console.log(`     ⚠️  附件${j+1} 下载链接为空`); continue; }
            const safeName = (f.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
            const fpath = join(TEMP_DIR, safeName);
            await downloadFile(dlUrl, fpath);
            localFiles.push(fpath);
          } catch (e) { console.log(`     ❌ 下载附件${j+1} 失败: ${e.message}`); }
        }
      }

      // 3c. 发布（文字帖用 MCP 保换行，文件帖用 CLI 传文件，失败回退 Playwright）
      let newId;
      if (localFiles.length > 0) {
        console.log(`  📤 CLI 发布（带 ${localFiles.length} 个文件）...`);
        try {
          newId = publishWithFiles(content, localFiles);
        } catch (cliErr) {
          const errMsg = cliErr.message || '';
          // upload_token 耗尽 或 CLI 其他失败 → 回退 Playwright
          if (errMsg.includes('missing upload_token') || errMsg.includes('upload')) {
            console.log(`  ⚠️  CLI 上传 token 耗尽，回退 Playwright 浏览器自动化...`);
          } else {
            console.log(`  ⚠️  CLI 发布失败: ${errMsg.slice(0, 100)}，回退 Playwright...`);
          }
          // 获取源账号（fetch）cookie — upload 账户 CLI 额度已耗尽，PW 回退用 fetch cookie
          const srcProfile = CONFIG.profiles?.[SRC.name] || CONFIG.profiles?.fetch || {};
          const pwCookie = srcProfile.cookie || '';
          if (pwCookie) {
            const pwResult = await publishViaPlaywright({
              text: content,
              filePaths: localFiles,
              cookie: pwCookie,
              groupId: DST.groupId,
              headless: true,
              timeout: 120000,
            });
            if (pwResult.topicId) {
              newId = pwResult.topicId;
              console.log(`  ✅ Playwright 回退成功 → ${newId}`);
            } else {
              console.log(`  ❌ Playwright 回退也失败: ${pwResult.error}`);
            }
          } else {
            console.log(`  ❌ 无法回退 Playwright: 缺少目标账号 cookie`);
          }
        }
      } else {
        // 纯文字帖：MCP 优先
        try {
          newId = await publishTextOnly(tagger, content);
        } catch (mcpErr) {
          console.log(`  ⚠️  MCP 发布失败: ${mcpErr.message?.slice(0, 100)}，回退 Playwright...`);
          const srcProfile = CONFIG.profiles?.[SRC.name] || CONFIG.profiles?.fetch || {};
          const pwCookie = srcProfile.cookie || '';
          if (pwCookie) {
            const pwResult = await publishViaPlaywright({
              text: content,
              filePaths: [],
              cookie: pwCookie,
              groupId: DST.groupId,
              headless: true,
              timeout: 60000,
            });
            if (pwResult.topicId) {
              newId = pwResult.topicId;
              console.log(`  ✅ Playwright 回退成功 → ${newId}`);
            } else {
              console.log(`  ❌ Playwright 回退也失败: ${pwResult.error}`);
            }
          } else {
            console.log(`  ❌ 无法回退 Playwright: 缺少目标账号 cookie`);
          }
        }
      }
      if (!newId) throw new Error('发布返回无 topic_id');

      // 3d. 打标签
      if (hashtags.length > 0 && tagger) {
        try {
          await tagger.callTool('set_topic_tags', { topic_id:newId, titles:hashtags });
          console.log(`  🏷️  标签已设置: ${hashtags.join(', ')}`);
        } catch (e) { console.log(`  ⚠️  标签设置失败: ${e.message}`); }
      }

      // 3e. 清理临时文件
      for (const fp of localFiles) { try { unlinkSync(fp); } catch {} }

      console.log(`  ✅ 发布成功 → ${newId}`);
      successCount++;
      record[srcId] = { newId, time: new Date().toISOString() };
      saveRecord(record);
      // 如果之前是失败的，成功后从失败列表清除
      if (failedSet.has(srcId)) {
        failed = failed.filter(f => f.sourceId !== srcId);
        saveFailed(failed);
      }

    } catch (err) {
      console.log(`  ❌ 失败: ${err.message}`);
      failCount++;
      failed.push({ sourceId:srcId, error:err.message, time:new Date().toISOString() });
      saveFailed(failed);
    }

    // 速率控制
    if (i < topicIds.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  // 4. 汇总
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 迁移汇总`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  成功: ${successCount}`);
  console.log(`  跳过: ${skipCount}`);
  console.log(`  失败: ${failCount}`);
  if (failed.length > 0) console.log(`  失败记录: ${FAILED_FILE}`);
  console.log('');

  if (!dryRun) {
    try { rmSync(TEMP_DIR, { recursive:true }); } catch {}
  }
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = { dryRun: false, limit: 20, count: 0, resume: false, from: 'fetch', to: 'upload' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--from':      args.from = argv[++i]; break;
      case '--to':        args.to = argv[++i]; break;
      case '--dry-run':   args.dryRun = true; break;
      case '--limit':     args.limit = parseInt(argv[++i], 10); break;
      case '--count':     args.count = parseInt(argv[++i], 10); break;
      case '--resume':    args.resume = true; break;
      case '--help': case '-h':
        const profiles = CONFIG.profiles ? Object.keys(CONFIG.profiles).join(', ') : '(无)';
        console.log(`迁移脚本 v2.0
用法: node scripts/migrate.mjs --from <源profile> --to <目标profile> [选项]

选项:
  --from <name>   抓取账号 profile 名称（默认 fetch）
  --to <name>     上传账号 profile 名称（默认 upload）
  --dry-run       预览模式，不实际发布
  --limit <n>     每批条数（默认 20，API 上限）
  --count <n>     总搬运条数，超过 20 时自动翻页（如 --count 500）
  --resume        续传模式，重试失败记录

可用 profiles: ${profiles}

示例:
  node scripts/migrate.mjs --from fetch --to upload --dry-run
  node scripts/migrate.mjs --from fetch --to upload --limit 10
  node scripts/migrate.mjs --from fetch --to upload --count 500   # 翻页搬运 500 条
  node scripts/migrate.mjs --from fetch --to upload --resume`);
        process.exit(0);
    }
  }
  return args;
}

// ── 启动 ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('❌ 异常:', err.message);
  process.exit(1);
});
