#!/usr/bin/env node
/**
 * zsxq MCP 文件下载脚本 v1.0
 *
 * 功能：通过 zsxq MCP API（JSON-RPC 协议）获取主题文件列表并批量下载。
 *       纯 MCP 依赖，无需 zsxq-cli，无需浏览器 Cookie，服务器环境可运行。
 *
 * 配置：支持 config.json profiles 多账号，通过 activeProfile 或 --profile 切换。
 *       profiles 中需要填写 mcpApiKey 字段（从 zsxq MCP 配置获取）。
 *
 * 用法：
 *   # 使用默认账号下载
 *   node download-files-mcp.mjs --group-id <星球ID>
 *
 *   # 切换账号
 *   node scripts/download-files-mcp.mjs --profile fetch --group-id <星球ID>
 *
 *   # 下载最近 N 条主题的文件
 *   node download-files-mcp.mjs --group-id <星球ID> --limit 20
 *
 *   # 下载单个主题的文件
 *   node download-files-mcp.mjs --topic-id <主题ID>
 *
 *   # 指定下载目录
 *   node download-files-mcp.mjs --group-id <星球ID> --output ./my-files
 *
 *   # 只下载图片 / 只下载附件
 *   node download-files-mcp.mjs --group-id <星球ID> --images-only
 *   node download-files-mcp.mjs --group-id <星球ID> --files-only
 *
 *   # 干跑预览
 *   node download-files-mcp.mjs --group-id <星球ID> --dry-run
 *
 * 前置条件：
 *   - config.json profiles 中配置 mcpApiKey
 *   - Node.js >= 18（fetch API）
 */

import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { join, basename, extname } from 'node:path';

// ── 外部配置 ────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = join(import.meta.dirname, '..', 'config.json');
  if (!existsSync(configPath)) {
    console.warn('⚠️  未找到 config.json，将仅使用命令行参数');
    return {};
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.warn(`⚠️  config.json 解析失败: ${err.message}`);
    return {};
  }
}

function resolveProfile(rawConfig, profileArg) {
  if (rawConfig.profiles) {
    const name = profileArg || rawConfig.activeProfile || Object.keys(rawConfig.profiles)[0];
    if (!rawConfig.profiles[name]) {
      console.warn(`⚠️  Profile "${name}" 不存在，可用: ${Object.keys(rawConfig.profiles).join(', ')}`);
      return {};
    }
    console.log(`🔑 当前账号: ${name}`);
    return rawConfig.profiles[name];
  }
  return rawConfig;
}

const EXTERNAL_CONFIG = loadConfig();

// ── 常量 ────────────────────────────────────────────────────────────────────

const MCP_BASE = 'https://mcp.zsxq.com/topic/mcp';
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico']);

let RATE_LIMIT_MS = 1500;

// ── MCP 客户端 ──────────────────────────────────────────────────────────────

/**
 * MCP JSON-RPC 调用封装
 * - 首次调用自动完成 initialize + initialized 握手
 * - 所有请求复用同一个会话（连续 fetch）
 */
class McpClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = `${MCP_BASE}?api_key=${apiKey}`;
    this.nextId = 10;
    this.initialized = false;
  }

  /** 初始化 MCP 会话 */
  async init() {
    if (this.initialized) return;
    // 1. initialize
    await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'download-files-mcp', version: '1.0' },
    });
    // 2. send initialized notification
    await fetch(this.baseUrl, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    this.initialized = true;
  }

  /** 调用 MCP 工具 */
  async callTool(name, args = {}) {
    await this.init();
    return this._rpc('tools/call', { name, arguments: args });
  }

  /** 底层 JSON-RPC 请求 */
  async _rpc(method, params) {
    const id = this.nextId++;
    const resp = await fetch(this.baseUrl, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
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

// ── API 封装 ────────────────────────────────────────────────────────────────

/** 通过 MCP call_zsxq_api 调用知识星球 API */
async function zsxqApi(client, method, path, body = null) {
  const args = { method, path };
  if (body) args.body = body;
  const result = await client.callTool('call_zsxq_api', args);
  const data = JSON.parse(result.content[0].text);
  // call_zsxq_api 有两种返回格式：
  // 1. 直接返回: { resp_data: {...}, succeeded: true }
  // 2. 包裹返回: { body: { resp_data: {...} } }
  if (data.succeeded) return data.resp_data || data;
  if (data.body?.resp_data) return data.body.resp_data;
  // 如果有 resp_data 但无 succeeded 字段
  if (data.resp_data) return data.resp_data;
  // 如果 body 里有其他字段
  if (data.body) return data.body;
  throw new Error(`API ${path} 失败: ${JSON.stringify(data).slice(0, 200)}`);
}

/** 获取星球主题列表 */
async function getGroupTopics(client, groupId, limit) {
  const result = await client.callTool('get_group_topics', { group_id: groupId, limit });
  const data = JSON.parse(result.content[0].text);
  if (!data.success && data.error) {
    throw new Error(data.error);
  }
  return data;
}

/** 获取主题详情（含 files / images）—— 使用专用 MCP 工具 get_topic_info */
async function getTopicDetail(client, topicId) {
  const result = await client.callTool('get_topic_info', { topic_id: topicId });
  const data = JSON.parse(result.content[0].text);
  // get_topic_info 返回 { topic: {...} } 结构
  return data.topic || data;
}

/** 获取文件下载链接 */
async function getDownloadUrl(client, fileId) {
  const data = await zsxqApi(client, 'GET', `/v2/files/${fileId}/download_url`);
  return data.download_url || null;
}

// ── 文件提取 ────────────────────────────────────────────────────────────────

function extractFilesFromTopic(topic) {
  const files = [];

  // 1. files 字段（附件）
  if (topic.files && Array.isArray(topic.files)) {
    for (const f of topic.files) {
      if (f.file_id) {
        files.push({
          fileId: f.file_id,
          name: f.name || 'unknown',
          size: f.size || 0,
          type: 'file',
        });
      }
    }
  }

  // 2. images 字段（图片，有直接 URL）
  if (topic.images && Array.isArray(topic.images)) {
    for (const img of topic.images) {
      // 图片 URL 可能在 img.url, img.original.url, img.large.url 等
      let url = '';
      if (typeof img === 'string') {
        url = img;
      } else if (typeof img.url === 'string') {
        url = img.url;
      } else if (img.original?.url) {
        url = img.original.url;
      } else if (img.large?.url) {
        url = img.large.url;
      } else if (img.medium?.url) {
        url = img.medium.url;
      } else if (img.small?.url) {
        url = img.small.url;
      }
      if (url) {
        // 优先用 API 返回的 type 作为扩展名（如 png），否则默认 jpg
        const imageExt = img.type || 'jpg';
        const rawName = img.name || filenameFromUrl(url) || `image_${files.length + 1}`;
        const name = rawName.includes('.') ? rawName : `${rawName}.${imageExt}`;
        files.push({
          fileId: null,
          directUrl: url,
          name: name,
          size: img.original?.size || img.size || 0,
          type: 'image',
        });
      }
    }
  }

  // 3. content 中的内嵌图片
  const contentStr = topic.content || topic.text || '';
  if (typeof contentStr === 'string') {
    const imgRegex = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
    let match;
    while ((match = imgRegex.exec(contentStr)) !== null) {
      const url = match[1];
      if (url.includes('zsxq.com') && !files.some(f => f.directUrl === url)) {
        const rawName = filenameFromUrl(url) || `embedded_${files.length + 1}`;
        files.push({
          fileId: null, directUrl: url,
          name: `embedded_${topic.topic_id}_${rawName.includes('.') ? rawName : rawName + '.jpg'}`,
          size: 0, type: 'image',
        });
      }
    }
    const htmlImgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    while ((match = htmlImgRegex.exec(contentStr)) !== null) {
      const url = match[1];
      if (!files.some(f => f.directUrl === url)) {
        const rawName = filenameFromUrl(url) || `embedded_${files.length + 1}`;
        files.push({
          fileId: null, directUrl: url,
          name: `embedded_${topic.topic_id}_${rawName.includes('.') ? rawName : rawName + '.jpg'}`,
          size: 0, type: 'image',
        });
      }
    }
  }

  return files;
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    let name = basename(u.pathname);
    // zsxq CDN 文件名通常是 hash（如 Fizjv9PEIa81WO5muDGaIbaXSo7r），直接用作文件名
    if (!name || name === '/') name = 'image';
    return name;
  } catch { return 'image'; }
}

/** 确保文件名有合适的扩展名 */
function ensureExt(name, type) {
  const ext = extname(name).toLowerCase();
  if (!ext) {
    // 图片默认 .jpg，文件根据 MIME 推测
    return name + (type === 'image' ? '.jpg' : '.bin');
  }
  return name;
}

function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
}

function formatSize(bytes) {
  if (bytes == null) return '未知大小';
  bytes = parseInt(bytes, 10);
  if (isNaN(bytes)) return '未知大小';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function isImageByExt(name) {
  return IMAGE_EXTS.has(extname(name).toLowerCase());
}

async function rateLimit() {
  const wait = RATE_LIMIT_MS;
  await new Promise(r => setTimeout(r, wait));
}

// ── 文件下载 ────────────────────────────────────────────────────────────────

function downloadFile(downloadUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const isHttps = downloadUrl.startsWith('https');
    const getFn = isHttps ? httpsGet : httpGet;

    getFn(downloadUrl, { timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const total = parseInt(res.headers['content-length'], 10) || 0;
      let downloaded = 0;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = ((downloaded / total) * 100).toFixed(0);
          process.stdout.write(`\r    下载中... ${pct}% (${formatSize(downloaded)}/${formatSize(total)})`);
        }
      });

      res.pipe(file);
      file.on('finish', () => { process.stdout.write('\n'); resolve(); });
      file.on('error', (e) => { file.close(); reject(e); });
    }).on('error', (e) => { file.close(); reject(e); })
      .on('timeout', () => { file.close(); reject(new Error('下载超时')); });
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // 合并配置：命令行 > profile > 平级字段 > 默认
  const profileConfig = resolveProfile(EXTERNAL_CONFIG, args.profile);
  const mcpApiKey = args.mcpApiKey || profileConfig.mcpApiKey || EXTERNAL_CONFIG.mcpApiKey || '';
  args.groupId  = args.groupId || profileConfig.groupId || EXTERNAL_CONFIG.groupId || '';
  args.limit    = args.limit || profileConfig.limit || EXTERNAL_CONFIG.limit || 50;
  args.output   = args.output || profileConfig.output || EXTERNAL_CONFIG.output || './downloads';
  args.rateLimitMs = args.rateLimitMs || profileConfig.rateLimitMs || EXTERNAL_CONFIG.rateLimitMs || 1500;
  RATE_LIMIT_MS = args.rateLimitMs;

  if (!mcpApiKey) {
    console.error('❌ 请在 config.json profiles 中配置 mcpApiKey，或通过 --mcp-api-key 传入');
    console.error('   获取方式：CodeBuddy MCP 配置中 zsxq 的 api_key');
    process.exit(1);
  }

  // 创建 MCP 客户端
  const client = new McpClient(mcpApiKey);
  console.log('🔗 连接 MCP 服务器...');
  await client.init();
  console.log('✅ MCP 已连接');

  // 1. 收集主题 ID
  const topicIds = [];
  if (args.topicId) {
    topicIds.push(args.topicId);
  } else if (args.groupId) {
    console.log(`\n📋 获取星球 [${args.groupId}] 主题列表...`);
    const list = await getGroupTopics(client, args.groupId, args.limit);
    for (const t of list.topics_brief) {
      topicIds.push(t.topic_id);
    }
    console.log(`  找到 ${topicIds.length} 个主题`);
  } else {
    console.error('❌ 请指定 --group-id 或 --topic-id');
    process.exit(1);
  }

  if (topicIds.length === 0) {
    console.log('没有找到主题，退出。');
    process.exit(0);
  }

  // 2. 创建输出目录
  if (!args.dryRun && !existsSync(args.output)) {
    mkdirSync(args.output, { recursive: true });
    console.log(`📁 输出目录: ${args.output}`);
  }

  // 3. 遍历主题，下载文件
  let totalFiles = 0;
  let successCount = 0;
  let failCount = 0;
  const failedDownloads = [];

  for (let i = 0; i < topicIds.length; i++) {
    const tid = topicIds[i];
    console.log(`\n📄 [${i + 1}/${topicIds.length}] ${tid}`);

    let topic;
    try {
      topic = await getTopicDetail(client, tid);
    } catch (err) {
      console.log(`  ⚠️  获取详情失败: ${err.message}`);
      continue;
    }

    let files = extractFilesFromTopic(topic);

    if (args.imagesOnly) files = files.filter(f => f.type === 'image' || (f.type === 'file' && isImageByExt(f.name)));
    else if (args.filesOnly) files = files.filter(f => f.type === 'file' && !isImageByExt(f.name));

    if (files.length === 0) {
      console.log(`  (无匹配文件)`);
      continue;
    }

    console.log(`  发现 ${files.length} 个文件`);

    for (const file of files) {
      totalFiles++;
      const safeName = safeFilename(ensureExt(file.name, file.type));
      const destPath = join(args.output, `${tid}_${safeName}`);
      const sizeStr = file.size ? ` (${formatSize(file.size)})` : '';

      console.log(`  📥 [${file.type}] ${safeName}${sizeStr}`);

      if (args.dryRun) {
        successCount++;
        continue;
      }

      if (existsSync(destPath)) {
        console.log(`     ⏭️  已存在，跳过`);
        successCount++;
        continue;
      }

      try {
        let downloadUrl;
        if (file.directUrl) {
          downloadUrl = file.directUrl;
          // 兼容 directUrl 是对象的情况（如 { original: "https://..." }）
          if (typeof downloadUrl !== 'string') {
            downloadUrl = downloadUrl.original || downloadUrl.large || downloadUrl.medium || downloadUrl.small || downloadUrl.url || '';
            if (!downloadUrl) throw new Error('图片 URL 格式异常');
          }
        } else if (file.fileId) {
          downloadUrl = await getDownloadUrl(client, file.fileId);
          if (!downloadUrl) throw new Error('无法获取下载链接');
        } else {
          throw new Error('无下载源');
        }

        console.log(`     URL: ${downloadUrl.slice(0, 80)}...`);
        await downloadFile(downloadUrl, destPath);
        console.log(`     ✅ ${destPath}`);
        successCount++;
      } catch (err) {
        console.log(`     ❌ ${err.message}`);
        failCount++;
        failedDownloads.push({ topicId: tid, fileId: file.fileId, name: file.name, error: err.message });
      }

      await rateLimit();
    }
  }

  // 4. 汇总
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 下载汇总');
  console.log(`${'='.repeat(60)}`);
  console.log(`  主题数:  ${topicIds.length}`);
  console.log(`  文件总数: ${totalFiles}`);
  console.log(`  成功:    ${successCount}`);
  console.log(`  失败:    ${failCount}`);
  console.log(`  输出目录: ${args.output}`);

  if (failedDownloads.length > 0) {
    console.log('\n  ❌ 失败列表:');
    for (const f of failedDownloads) console.log(`     [${f.topicId}] ${f.name} — ${f.error}`);
  }
  console.log('');
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    groupId: null, topicId: null, mcpApiKey: null, profile: null,
    limit: null, output: null, rateLimitMs: null,
    dryRun: false, imagesOnly: false, filesOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--group-id':     args.groupId = argv[++i]; break;
      case '--topic-id':     args.topicId = argv[++i]; break;
      case '--mcp-api-key':  args.mcpApiKey = argv[++i]; break;
      case '--profile':      args.profile = argv[++i]; break;
      case '--limit':        args.limit = parseInt(argv[++i], 10); break;
      case '--output':       args.output = argv[++i]; break;
      case '--rate-limit':   args.rateLimitMs = parseInt(argv[++i], 10); break;
      case '--dry-run':      args.dryRun = true; break;
      case '--images-only':  args.imagesOnly = true; break;
      case '--files-only':   args.filesOnly = true; break;
      case '--help': case '-h': printHelp(); process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
zsxq MCP 文件下载脚本 v1.0

用法:
  node scripts/download-files-mcp.mjs [选项]

选项:
  --group-id <id>   星球 ID
  --topic-id <id>   单个主题 ID
  --profile <name>  使用指定账号 profile（默认 activeProfile）
  --mcp-api-key <k> 直接传入 MCP API Key（优先于配置文件）
  --limit <n>       最多获取主题数（默认 50）
  --output <dir>    下载目录（默认 ./downloads）
  --rate-limit <ms> 请求间隔毫秒（默认 1500）
  --dry-run         干跑模式，只列出不下载
  --images-only     只下载图片
  --files-only      只下载附件
  --help, -h        显示帮助

配置:
  在 config.json 的 profiles 中填写 mcpApiKey 字段即可，
  无需 cookie，无需 zsxq-cli。

示例:
  node scripts/download-files-mcp.mjs --group-id 88882114281542
  node scripts/download-files-mcp.mjs --profile fetch --group-id 88882114281542
  node scripts/download-files-mcp.mjs --group-id 88882114281542 --dry-run
  node scripts/download-files-mcp.mjs --topic-id 412451448515528
`);
}

// ── 启动 ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('❌ 脚本异常:', err.message);
  process.exit(1);
});
