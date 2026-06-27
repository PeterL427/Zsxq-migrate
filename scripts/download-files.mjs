#!/usr/bin/env node
/**
 * zsxq-cli 文件下载脚本 v2.3
 *
 * 功能：通过 zsxq-cli 获取知识星球主题中的文件列表，
 *       利用 Cookie 认证获取下载链接，批量下载到本地。
 *
 * 配置：支持从 config.json 读取默认值（cookie、groupId 等），
 *       命令行参数优先级高于配置文件。
 *
 * 用法：
 *   # 在 config.json 中配置 cookie 后，简化运行
 *   node download-files.mjs --group-id <星球ID>
 *
 *   # 下载指定星球的最近 N 条主题文件
 *   node download-files.mjs --group-id <星球ID> --limit 20
 *
 *   # 下载单个主题的文件
 *   node download-files.mjs --topic-id <主题ID>
 *
 *   # 指定下载目录（默认 ./downloads）
 *   node download-files.mjs --group-id <星球ID> --output ./my-files
 *
 *   # 只下载图片
 *   node download-files.mjs --group-id <星球ID> --images-only
 *
 *   # 只下载附件（非图片文件）
 *   node download-files.mjs --group-id <星球ID> --files-only
 *
 *   # 干跑（只列出文件，不下载）
 *   node download-files.mjs --group-id <星球ID> --dry-run
 *
 * 前置条件：
 *   - 已安装 zsxq-cli 并完成登录：npx zsxq-cli auth login
 *   - 认证状态检查：npx zsxq-cli auth status
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { join, basename, extname } from 'node:path';

// ── 外部配置导入 ────────────────────────────────────────────────────────────

/** 从 config.json 加载原始配置（文件不存在时返回空对象，不解析 profile） */
function loadConfig() {
  const configPath = join(import.meta.dirname, '..', 'config.json');
  if (!existsSync(configPath)) {
    console.warn('⚠️  未找到 config.json，将仅使用命令行参数');
    return {};
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`⚠️  config.json 解析失败: ${err.message}，将仅使用命令行参数`);
    return {};
  }
}

/** 从 profiles 或多平级配置中提取当前账号配置 */
function resolveProfile(rawConfig, profileArg) {
  // 有 profiles 字段 → 多账号模式
  if (rawConfig.profiles) {
    const profileName = profileArg || rawConfig.activeProfile || Object.keys(rawConfig.profiles)[0];
    if (!rawConfig.profiles[profileName]) {
      console.warn(`⚠️  Profile "${profileName}" 不存在，可用: ${Object.keys(rawConfig.profiles).join(', ')}`);
      return {};
    }
    console.log(`🔑 当前账号: ${profileName}`);
    return rawConfig.profiles[profileName];
  }
  // 无 profiles 字段 → 旧版平级配置（向后兼容）
  return rawConfig;
}

const EXTERNAL_CONFIG = loadConfig();

// ── 常量配置 ────────────────────────────────────────────────────────────────

const CLI = 'npx zsxq-cli';
const API_BASE = 'https://api.zsxq.com/v2';
let RATE_LIMIT_MS = EXTERNAL_CONFIG.rateLimitMs || 1500;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico']);
const FILE_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.mp4', '.mp3', '.avi', '.mov', '.wmv',
  '.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.psd', '.ai', '.sketch']);

// ── 全局状态 ────────────────────────────────────────────────────────────────

let lastRequestTime = 0;
let cookie = '';

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 速率限制：确保两次请求间隔 >= RATE_LIMIT_MS */
async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    const wait = RATE_LIMIT_MS - elapsed;
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}

/** 执行 zsxq-cli 命令，返回 JSON 对象 */
function zsxq(args) {
  const cmd = `${CLI} ${args}`;
  console.log(`  [CMD] ${cmd}`);
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch (err) {
    const stderr = err.stderr || '';
    console.error(`  [ERR] 命令失败: ${stderr.slice(0, 200)}`);
    return null;
  }
}

/** HTTP GET 请求（支持 Cookie） */
function httpRequest(url, cookieHeader) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const getFn = isHttps ? httpsGet : httpGet;

    const options = {
      headers: cookieHeader ? { 'Cookie': cookieHeader } : {},
      timeout: 60000,
    };

    getFn(url, options, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpRequest(res.headers.location, cookieHeader).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
        return;
      }

      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('请求超时')));
  });
}

/** 通过 Cookie 获取文件下载 URL */
async function resolveDownloadUrl(fileId) {
  await rateLimit();
  const url = `${API_BASE}/files/${fileId}/download_url`;
  console.log(`     [API] GET ${url}`);
  try {
    const result = await httpRequest(url, cookie);
    if (result && result.succeeded && result.resp_data && result.resp_data.download_url) {
      return result.resp_data.download_url;
    }
    console.error(`     [WARN] 获取下载链接失败: ${JSON.stringify(result).slice(0, 200)}`);
    return null;
  } catch (err) {
    console.error(`     [ERR] 获取下载链接异常: ${err.message}`);
    return null;
  }
}

/** 安全文件名 */
function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
}

/** 判断是否为图片（基于扩展名） */
function isImageByExt(name) {
  const ext = extname(name).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

/** 判断是否为附件文件 */
function isFileByExt(name) {
  const ext = extname(name).toLowerCase();
  return FILE_EXTS.has(ext) || (ext && !IMAGE_EXTS.has(ext));
}

/** 从 URL 路径提取文件名 */
function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return basename(pathname) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 格式化文件大小 */
function formatSize(bytes) {
  if (bytes == null) return '未知大小';
  bytes = parseInt(bytes, 10);
  if (isNaN(bytes)) return '未知大小';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 下载文件到本地 */
function downloadFile(downloadUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const isHttps = downloadUrl.startsWith('https');
    const getFn = isHttps ? httpsGet : httpGet;

    getFn(downloadUrl, { timeout: 120000 }, (res) => {
      // 处理重定向
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
      file.on('finish', () => {
        process.stdout.write('\n');
        resolve();
      });
      file.on('error', (e) => {
        file.close();
        reject(e);
      });
    }).on('error', (e) => {
      file.close();
      reject(e);
    }).on('timeout', () => {
      file.close();
      reject(new Error('下载超时'));
    });
  });
}

// ── 主题详情获取 ────────────────────────────────────────────────────────────

/**
 * 通过 shortcut 获取主题详情
 * 使用 zsxq-cli topic +detail，比 raw API 更稳定
 */
function getTopicDetail(topicId) {
  const result = zsxq(`topic +detail --topic-id ${topicId}`);
  // shortcut 返回的是 { topic: {...} }，提取 topic 对象
  if (result && result.topic) {
    return result.topic;
  }
  return null;
}


/**
 * 从主题详情中提取文件信息
 * API 返回的 files 结构：
 *   { file_id, name, size, download_count, hash, source, create_time, duration }
 */
function extractFilesFromTopic(topic) {
  const files = [];

  // 1. 提取 files 字段（附件列表）
  if (topic.files && Array.isArray(topic.files)) {
    for (const f of topic.files) {
      const fileInfo = {
        fileId: f.file_id || '',
        name: f.name || 'unknown',
        size: f.size || 0,
        type: isImageByExt(f.name || '') ? 'image' : 'file',
      };
      if (fileInfo.fileId) {
        files.push(fileInfo);
      }
    }
  }

  // 2. 提取 images 字段（图片列表）
  if (topic.images && Array.isArray(topic.images)) {
    for (const img of topic.images) {
      let url = '';
      if (typeof img === 'string') {
        url = img;
      } else if (img.original) {
        url = img.original;
      } else if (img.large) {
        url = img.large;
      } else if (img.medium) {
        url = img.medium;
      } else if (img.small) {
        url = img.small;
      } else if (img.url) {
        url = img.url;
      }

      if (url) {
        // 图片直接有 URL，不需要通过 file_id 解析
        files.push({
          fileId: null,
          directUrl: url,
          name: img.name || filenameFromUrl(url) || `image_${files.length + 1}`,
          size: img.size || 0,
          type: 'image',
        });
      }
    }
  }

  // 3. 从 content / text 中提取内嵌的图片 URL（知识星球 CDN）
  const contentStr = topic.content || topic.text || '';
  if (typeof contentStr === 'string') {
    // 匹配 Markdown 图片语法和直接 URL
    const imgRegex = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
    let match;
    while ((match = imgRegex.exec(contentStr)) !== null) {
      const url = match[1];
      if (url.includes('zsxq.com') && !files.some(f => f.directUrl === url)) {
        files.push({
          fileId: null,
          directUrl: url,
          name: filenameFromUrl(url) || `embedded_${files.length + 1}`,
          size: 0,
          type: 'image',
        });
      }
    }

    // 匹配 HTML img 标签
    const htmlImgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    while ((match = htmlImgRegex.exec(contentStr)) !== null) {
      const url = match[1];
      if (!files.some(f => f.directUrl === url)) {
        files.push({
          fileId: null,
          directUrl: url,
          name: filenameFromUrl(url) || `embedded_${files.length + 1}`,
          size: 0,
          type: 'image',
        });
      }
    }
  }

  return files;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // ── 合并外部配置：命令行参数 > profile > 平级字段 > 默认值 ──
  const profileConfig = resolveProfile(EXTERNAL_CONFIG, args.profile);
  args.cookie   = args.cookie || profileConfig.cookie || EXTERNAL_CONFIG.cookie || '';
  args.groupId  = args.groupId || profileConfig.groupId || EXTERNAL_CONFIG.groupId || '';
  args.limit    = args.limit || profileConfig.limit || EXTERNAL_CONFIG.limit || 50;
  args.output   = args.output || profileConfig.output || EXTERNAL_CONFIG.output || './downloads';
  args.rateLimitMs = args.rateLimitMs || profileConfig.rateLimitMs || EXTERNAL_CONFIG.rateLimitMs || 1500;

  // 验证 Cookie
  if (!args.cookie) {
    console.error('❌ 请提供 zsxq_access_token（任选其一）：');
    console.error('   1. 命令行: --cookie "<token>"');
    console.error('   2. 在 config.json 中填写 "cookie" 字段');
    console.error('   获取方法：浏览器登录 knowledge.zsxq.com -> F12 -> Application -> Cookies');
    process.exit(1);
  }
  cookie = args.cookie;

  // 应用 profile 的速率限制
  RATE_LIMIT_MS = args.rateLimitMs || 1500;

  // 1. 收集要下载的主题列表
  const topicIds = [];

  if (args.topicId) {
    topicIds.push(args.topicId);
  } else if (args.groupId) {
    console.log(`\n📋 正在获取星球 [${args.groupId}] 的主题列表...`);

    const params = JSON.stringify({ group_id: args.groupId, limit: args.limit });
    // Windows cmd.exe: 双引号需要双重转义
    const esc = process.platform === 'win32' ? params.replace(/"/g, '""') : params;
    const wrapper = process.platform === 'win32' ? `"${esc}"` : `'${params}'`;
    const result = zsxq(`api call get_group_topics --params ${wrapper}`);
    if (!result || !result.topics_brief) {
      console.error('❌ 获取主题列表失败，请确认：');
      console.error('   1. 已登录：npx zsxq-cli auth login');
      console.error('   2. 星球ID正确：npx zsxq-cli group list');
      process.exit(1);
    }

    for (const t of result.topics_brief) {
      topicIds.push(t.topic_id);
    }
    console.log(`  找到 ${topicIds.length} 个主题`);
  } else {
    console.error('❌ 请指定 --group-id 或 --topic-id');
    console.error('   用法：node download-files.mjs --group-id <星球ID> --cookie "<token>"');
    process.exit(1);
  }

  if (topicIds.length === 0) {
    console.log('没有找到任何主题，退出。');
    process.exit(0);
  }

  // 2. 创建输出目录
  if (!args.dryRun && !existsSync(args.output)) {
    mkdirSync(args.output, { recursive: true });
    console.log(`📁 创建输出目录: ${args.output}`);
  }

  // 3. 逐个主题获取详情并下载文件
  let totalFiles = 0;
  let successCount = 0;
  let failCount = 0;
  const failedDownloads = [];

  for (let i = 0; i < topicIds.length; i++) {
    const tid = topicIds[i];
    console.log(`\n📄 [${i + 1}/${topicIds.length}] 主题: ${tid}`);

    const topic = getTopicDetail(tid);
    if (!topic) {
      console.log(`  ⚠️  获取主题详情失败，跳过`);
      continue;
    }

    const files = extractFilesFromTopic(topic);

    // 过滤
    let filtered = files;
    if (args.imagesOnly) {
      filtered = files.filter(f => f.type === 'image');
    } else if (args.filesOnly) {
      filtered = files.filter(f => f.type === 'file');
    }

    if (filtered.length === 0) {
      console.log(`  (无匹配文件)`);
      continue;
    }

    console.log(`  发现 ${filtered.length} 个文件`);

    for (const file of filtered) {
      totalFiles++;
      const safeName = safeFilename(file.name);
      const filename = `${tid}_${safeName}`;
      const destPath = join(args.output, filename);

      const sizeStr = file.size ? ` (${formatSize(file.size)})` : '';
      console.log(`  📥 [${file.type}] ${safeName}${sizeStr}`);

      if (args.dryRun) {
        console.log(`     (干跑模式，跳过下载)`);
        successCount++;
        continue;
      }

      // 跳过已存在的文件
      if (existsSync(destPath)) {
        console.log(`     ⏭️  已存在，跳过`);
        successCount++;
        continue;
      }

      try {
        // 获取下载链接
        let downloadUrl;
        if (file.directUrl) {
          // 图片直接 URL，无需解析
          downloadUrl = file.directUrl;
          console.log(`     URL: ${downloadUrl.slice(0, 80)}...`);
        } else if (file.fileId) {
          // 附件需要通过 API 获取下载链接
          downloadUrl = await resolveDownloadUrl(file.fileId);
          if (!downloadUrl) {
            throw new Error('无法获取下载链接');
          }
          console.log(`     URL: ${downloadUrl.slice(0, 80)}...`);
        } else {
          throw new Error('文件既无直接 URL 也无 file_id');
        }

        await downloadFile(downloadUrl, destPath);
        console.log(`     ✅ 下载成功 -> ${destPath}`);
        successCount++;
      } catch (err) {
        console.log(`     ❌ 下载失败: ${err.message}`);
        failCount++;
        failedDownloads.push({
          topicId: tid,
          fileId: file.fileId,
          name: file.name,
          error: err.message,
        });
      }

      // 速率限制
      await rateLimit();
    }
  }

  // 4. 输出汇总
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 下载汇总');
  console.log(`${'='.repeat(60)}`);
  console.log(`  主题数:      ${topicIds.length}`);
  console.log(`  文件总数:    ${totalFiles}`);
  console.log(`  成功:        ${successCount}`);
  console.log(`  失败:        ${failCount}`);
  console.log(`  输出目录:    ${args.output}`);

  if (failedDownloads.length > 0) {
    console.log('\n  ❌ 失败文件列表:');
    for (const f of failedDownloads) {
      console.log(`     [${f.topicId}] ${f.name} — ${f.error}`);
    }
  }
  console.log('');
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    groupId: null,
    topicId: null,
    cookie: null,
    limit: null,
    output: null,
    profile: null,
    rateLimitMs: null,
    dryRun: false,
    imagesOnly: false,
    filesOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--group-id':
        args.groupId = argv[++i];
        break;
      case '--topic-id':
        args.topicId = argv[++i];
        break;
      case '--cookie':
        args.cookie = argv[++i];
        break;
      case '--limit':
        args.limit = parseInt(argv[++i], 10);
        break;
      case '--output':
        args.output = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--images-only':
        args.imagesOnly = true;
        break;
      case '--files-only':
        args.filesOnly = true;
        break;
      case '--profile':
        args.profile = argv[++i];
        break;
      case '--rate-limit':
        args.rateLimitMs = parseInt(argv[++i], 10);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
zsxq-cli 文件下载脚本 v2.3

用法:
  node scripts/download-files.mjs [选项]

选项:
  --group-id <id>    星球 ID（也可在 config.json 中配置）
  --topic-id <id>    单个主题 ID
  --profile <name>   指定使用的账号 profile（默认使用 activeProfile）
  --cookie <token>   浏览器 Cookie 的 zsxq_access_token（也可在 config.json 中配置）
  --limit <n>        最多获取主题数（默认 50，也可在 config.json 中配置）
  --output <dir>     下载目录（默认 ./downloads，也可在 config.json 中配置）
  --rate-limit <ms>  请求间隔毫秒（默认 1500，也可在 config.json 中配置）
  --dry-run          干跑模式，只列出文件不下载
  --images-only      只下载图片
  --files-only       只下载附件（非图片）
  --help, -h         显示帮助

多账号配置:
  config.json 支持 profiles 字段配置多个账号，通过 activeProfile 或 --profile 切换。
  示例结构见 config.example.json。

示例:
  # 使用默认账号
  node scripts/download-files.mjs --group-id 88882114281542

  # 切换到 fetch（抓取账号）
  node scripts/download-files.mjs --profile fetch --group-id 88882114281542

  # 先预览有哪些文件
  node scripts/download-files.mjs --group-id 88882114281542 --dry-run

  # 下载单个主题的文件
  node scripts/download-files.mjs --topic-id 412451448515528
`);
}

// ── 启动 ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('❌ 脚本异常:', err.message);
  process.exit(1);
});
