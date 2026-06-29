#!/usr/bin/env node
/**
 * IMA 知识库文件上传模块（多账号轮换版）
 *
 * 将文件上传到腾讯 IMA 知识库的指定文件夹，支持多账号自动轮换。
 * 完整流程: preflight-check → check_repeated_names → create_media → cos-upload → add_knowledge
 *
 * 多账号策略:
 *   - config.json ima.accounts 数组配置多个凭证
 *   - 上传成功 → 当前账号保持活跃
 *   - 上传失败（限流/额度耗尽）→ 自动切换下一账号重试
 *   - 全部账号失败 → 返回错误
 *   - 活跃账号索引持久化到 ima-account-state.json
 *
 * 用法（模块导入）:
 *   import { uploadFileToIma, getFolderIdByTags } from './ima-upload.mjs';
 *   const result = await uploadFileToIma(filePath, folderId);
 *
 * 用法（命令行）:
 *   node scripts/ima-upload.mjs --file <path> --folder <folder_id>
 *   node scripts/ima-upload.mjs --help
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 配置加载 ────────────────────────────────────────────────────────────────

const CONFIG = (() => {
  try { return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config.json'), 'utf-8')); }
  catch { return {}; }
})();

const IMA_CONFIG = CONFIG.ima || {};

/** IMA 知识库 ID */
export const KB_ID = IMA_CONFIG.knowledgeBaseId || '1ACD5SeZh8opkjddYuQ25-x-OSQgQ8nynY6FGwkVw38=';

/** Tag → 文件夹 ID 映射 */
export const TAG_FOLDER_MAP = IMA_CONFIG.tagFolderMap || {
  '#每日市场分析#': 'folder_7477018631354034',
  '#深度研报#': 'folder_7477018572632234',
  '#调研纪要#': 'folder_7477018530703933',
  '#内资研报#': 'folder_7477018400668440',
  '#外资研报#': 'folder_7477018320974863',
  '#财联社#': 'folder_7477018253880633',
  '#脱水研报#': 'folder_7477018111272541',
  '#录音#': 'folder_7477018060939962',
  '#数据#': 'folder_7477029758844554',
};

/** IMA 账号列表 */
const IMA_ACCOUNTS = IMA_CONFIG.accounts || [];

/** 账号状态文件：记录当前活跃账号索引 */
const STATE_FILE = join(import.meta.dirname, '..', 'ima-account-state.json');

/** IMA skill 脚本目录（项目内 vendor，自包含无需额外安装） */
const SKILL_DIR = process.env.IMA_SKILL_DIR || join(import.meta.dirname, '..', 'vendor', 'ima-skills');
const IMA_API_SCRIPT = join(SKILL_DIR, 'ima_api.cjs');
const PREFLIGHT_SCRIPT = join(SKILL_DIR, 'knowledge-base', 'scripts', 'preflight-check.cjs');
const COS_UPLOAD_SCRIPT = join(SKILL_DIR, 'knowledge-base', 'scripts', 'cos-upload.cjs');

// ── 账号管理 ────────────────────────────────────────────────────────────────

/**
 * 触发账号切换的错误特征：
 * - 请求频控 (110021)
 * - 无权限 (110030) — 可能是额度耗尽
 * - 包含"频控""限制""limit""quota""rate"等关键词
 */
function shouldSwitchAccount(resp) {
  if (!resp) return false;
  // 业务错误码
  if (resp.code === 110021 || resp.code === 110030) return true;
  // 错误消息关键词（中英文）
  const msg = (resp.msg || '').toLowerCase();
  if (/频控|限制|limit|quota|rate|exceed|too many|throttl|超限|超量|频率|稍后重试|明日再试/.test(msg)) return true;
  return false;
}

/**
 * 加载账号状态文件，返回当前活跃账号索引
 */
function loadAccountState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return state.activeIndex || 0;
  } catch { return 0; }
}

/**
 * 保存活跃账号索引到状态文件
 */
function saveAccountState(activeIndex, accountName) {
  writeFileSync(STATE_FILE, JSON.stringify({
    activeIndex,
    accountName,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * 获取当前活跃账号
 */
function getActiveAccount() {
  if (IMA_ACCOUNTS.length === 0) return null;
  const idx = Math.min(loadAccountState(), IMA_ACCOUNTS.length - 1);
  return { ...IMA_ACCOUNTS[idx], _index: idx };
}

/**
 * 切换到下一个可用账号，返回新账号或 null（无可用账号）
 * @param {number} failedIndex - 失败的账号索引
 * @returns {object|null} 新账号（含 _index）或 null
 */
function switchToNextAccount(failedIndex) {
  if (IMA_ACCOUNTS.length <= 1) return null;
  const nextIndex = (failedIndex + 1) % IMA_ACCOUNTS.length;
  saveAccountState(nextIndex, IMA_ACCOUNTS[nextIndex].name || `account${nextIndex + 1}`);
  return { ...IMA_ACCOUNTS[nextIndex], _index: nextIndex };
}

// ── IMA API 调用 ────────────────────────────────────────────────────────────

let _imaApi = null;

async function getImaApi() {
  if (_imaApi) return _imaApi;
  const mod = await import(pathToFileURL(IMA_API_SCRIPT).href);
  _imaApi = mod.imaApi;
  return _imaApi;
}

/**
 * 调用 IMA API，传入指定账号凭证
 * @param {string} apiPath - API 路径
 * @param {object} body - 请求体
 * @param {object} account - 账号 { clientId, apiKey }
 */
async function imaApi(apiPath, body, account) {
  const fn = await getImaApi();
  const respText = await fn(apiPath, body, {
    clientId: account.clientId,
    apiKey: account.apiKey,
  });
  return JSON.parse(respText);
}

// ── preflight-check ────────────────────────────────────────────────────────

/**
 * 运行 preflight-check，返回文件元信息
 */
function preflightCheck(filePath) {
  const result = spawnSync('node', [PREFLIGHT_SCRIPT, '--file', filePath], {
    encoding: 'utf-8',
    timeout: 30000,
  });

  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error(`preflight-check 无输出\nstderr: ${(result.stderr || '').slice(0, 200)}`);
  }

  return JSON.parse(stdout);
}

// ── COS 上传 ────────────────────────────────────────────────────────────────

/**
 * 上传文件到 COS
 */
function cosUpload(filePath, cosCredential, contentType) {
  const args = [
    COS_UPLOAD_SCRIPT,
    '--file', filePath,
    '--secret-id', cosCredential.secret_id,
    '--secret-key', cosCredential.secret_key,
    '--token', cosCredential.token,
    '--bucket', cosCredential.bucket_name,
    '--region', cosCredential.region,
    '--cos-key', cosCredential.cos_key,
    '--content-type', contentType,
    '--start-time', String(cosCredential.start_time),
    '--expired-time', String(cosCredential.expired_time),
    '--timeout', '300000',
  ];

  const result = spawnSync('node', args, {
    encoding: 'utf-8',
    timeout: 360000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    return { success: false, error: `cos-upload 退出码 ${result.status}: ${(result.stderr || '').slice(0, 300)}` };
  }

  return { success: true };
}

// ── 单账号上传（内部函数）────────────────────────────────────────────────

/**
 * 用指定账号上传文件（不包含轮换逻辑）
 * @returns {Promise<{success:boolean, mediaId?:string, error?:string, needSwitch?:boolean}>}
 */
async function _uploadWithAccount(filePath, folderId, account, options = {}) {
  const { onLog = (msg) => console.log(msg) } = options;
  const log = (msg) => onLog(msg);

  // Step 1: preflight-check (GATE 1)
  let preflight;
  try {
    preflight = preflightCheck(filePath);
  } catch (e) {
    return { success: false, error: `preflight-check 失败: ${e.message}` };
  }

  if (!preflight.pass) {
    return { success: false, error: `不支持此文件类型: ${preflight.reason || ''}` };
  }

  const { file_name, file_ext, file_size, media_type, content_type } = preflight;

  try {
    // Step 2: check_repeated_names (GATE 3)
    const checkResp = await imaApi('openapi/wiki/v1/check_repeated_names', {
      params: [{ name: file_name, media_type: media_type }],
      knowledge_base_id: KB_ID,
      folder_id: folderId,
    }, account);

    if (shouldSwitchAccount(checkResp)) {
      return { success: false, error: `账号${account.name}受限: ${checkResp.msg}`, needSwitch: true };
    }
    if (checkResp.code !== 0) {
      return { success: false, error: `check_repeated_names 失败: ${checkResp.msg}` };
    }

    const isRepeated = checkResp.data?.results?.[0]?.is_repeated;
    let finalFileName = file_name;
    if (isRepeated) {
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dotIdx = file_name.lastIndexOf('.');
      if (dotIdx > 0) {
        finalFileName = `${file_name.slice(0, dotIdx)}_${ts}${file_name.slice(dotIdx)}`;
      } else {
        finalFileName = `${file_name}_${ts}`;
      }
      log(`     ⚠️  重名，重命名为: ${finalFileName}`);
    }

    // Step 3: create_media
    const createResp = await imaApi('openapi/wiki/v1/create_media', {
      file_name: finalFileName,
      file_size: file_size,
      content_type: content_type,
      knowledge_base_id: KB_ID,
      file_ext: file_ext,
    }, account);

    if (shouldSwitchAccount(createResp)) {
      return { success: false, error: `账号${account.name}受限: ${createResp.msg}`, needSwitch: true };
    }
    if (createResp.code !== 0) {
      return { success: false, error: `create_media 失败: ${createResp.msg}` };
    }

    const mediaId = createResp.data?.media_id;
    const cosCredential = createResp.data?.cos_credential;

    if (!mediaId || !cosCredential) {
      return { success: false, error: 'create_media 返回缺少 media_id 或 cos_credential' };
    }

    // Step 4: cos-upload (GATE 5)
    const uploadResult = cosUpload(filePath, cosCredential, content_type);
    if (!uploadResult.success) {
      return { success: false, error: uploadResult.error };
    }

    // Step 5: add_knowledge (GATE 2: title = file_name)
    const addResp = await imaApi('openapi/wiki/v1/add_knowledge', {
      media_type: media_type,
      media_id: mediaId,
      title: finalFileName,
      knowledge_base_id: KB_ID,
      folder_id: folderId,
      file_info: {
        cos_key: cosCredential.cos_key,
        file_size: file_size,
        file_name: finalFileName,
      },
    }, account);

    if (shouldSwitchAccount(addResp)) {
      return { success: false, error: `账号${account.name}受限: ${addResp.msg}`, needSwitch: true };
    }
    if (addResp.code !== 0) {
      return { success: false, error: `add_knowledge 失败: ${addResp.msg}` };
    }

    return { success: true, mediaId: addResp.data?.media_id || mediaId };

  } catch (e) {
    // 网络错误等异常，也尝试切换
    const msg = e.message || '';
    if (/频控|限制|limit|quota|rate|exceed|too many|throttl|110021|110030/i.test(msg)) {
      return { success: false, error: `账号${account.name}异常: ${msg}`, needSwitch: true };
    }
    return { success: false, error: e.message };
  }
}

// ── 核心上传流程（带多账号轮换）─────────────────────────────────────────────

/**
 * 上传单个文件到 IMA 知识库（自动多账号轮换）
 * @param {string} filePath - 本地文件路径
 * @param {string} folderId - 目标文件夹 ID
 * @param {object} options - { dryRun:boolean, onLog:function }
 * @returns {Promise<{success:boolean, mediaId?:string, error?:string, account?:string}>}
 */
export async function uploadFileToIma(filePath, folderId, options = {}) {
  const { dryRun = false, onLog = (msg) => console.log(msg) } = options;
  const log = (msg) => onLog(msg);

  if (!existsSync(filePath)) {
    return { success: false, error: `文件不存在: ${filePath}` };
  }

  // dry-run 模式
  if (dryRun) {
    log(`     🔍 preflight-check...`);
    let preflight;
    try {
      preflight = preflightCheck(filePath);
    } catch (e) {
      return { success: false, error: `preflight-check 失败: ${e.message}` };
    }
    if (!preflight.pass) {
      return { success: false, error: `不支持此文件类型: ${preflight.reason || ''}` };
    }
    const { file_name, file_size, media_type } = preflight;
    log(`     📄 ${file_name} (${(file_size / 1024 / 1024).toFixed(2)}MB, type=${media_type})`);
    const account = getActiveAccount();
    log(`     [dry-run] 跳过实际上传 (账号: ${account?.name || '默认'})`);
    return { success: true, mediaId: 'dry_run', account: account?.name };
  }

  // 无账号配置
  if (IMA_ACCOUNTS.length === 0) {
    return { success: false, error: 'config.json 中未配置 ima.accounts' };
  }

  // 从当前活跃账号开始尝试，最多轮换一圈
  const startAccount = getActiveAccount();
  if (!startAccount) {
    return { success: false, error: '无可用 IMA 账号' };
  }

  let currentAccount = startAccount;
  let lastError = '';

  for (let attempt = 0; attempt < IMA_ACCOUNTS.length; attempt++) {
    const accName = currentAccount.name || `account${currentAccount._index + 1}`;
    log(`     🔍 preflight-check... [账号: ${accName}]`);

    let preflight;
    try {
      preflight = preflightCheck(filePath);
    } catch (e) {
      return { success: false, error: `preflight-check 失败: ${e.message}` };
    }
    if (!preflight.pass) {
      return { success: false, error: `不支持此文件类型: ${preflight.reason || ''}` };
    }

    const { file_name, file_size, media_type } = preflight;
    log(`     📄 ${file_name} (${(file_size / 1024 / 1024).toFixed(2)}MB, type=${media_type})`);
    log(`     📤 上传中 [账号: ${accName}]...`);

    const result = await _uploadWithAccount(filePath, folderId, currentAccount, { onLog });

    if (result.success) {
      // 成功 → 保持当前账号活跃
      saveAccountState(currentAccount._index, accName);
      log(`     ✅ 已上传: ${file_name} [账号: ${accName}]`);
      return { success: true, mediaId: result.mediaId, account: accName };
    }

    lastError = result.error;
    log(`     ⚠️  账号 ${accName} 失败: ${result.error}`);

    if (result.needSwitch) {
      const next = switchToNextAccount(currentAccount._index);
      if (!next) {
        log(`     ❌ 仅一个账号，无法切换`);
        break;
      }
      if (next._index === startAccount._index && attempt > 0) {
        log(`     ❌ 所有账号均已尝试，轮换完成`);
        break;
      }
      log(`     🔄 切换到账号: ${next.name || `account${next._index + 1}`}`);
      currentAccount = next;
      await new Promise(r => setTimeout(r, 2000)); // 切换后短暂等待，避免立即打新账号
    } else {
      // 非限流错误，不切换账号，直接返回失败
      break;
    }
  }

  return { success: false, error: lastError, account: currentAccount?.name };
}

// ── Tag → 文件夹映射 ────────────────────────────────────────────────────────

/**
 * 根据 tag 列表确定目标文件夹 ID
 */
export function getFolderIdByTags(tags) {
  if (!tags || tags.length === 0) return null;
  for (const tag of tags) {
    if (TAG_FOLDER_MAP[tag]) return TAG_FOLDER_MAP[tag];
  }
  return null;
}

/**
 * 根据 folderId 反查 tag 名称（用于日志显示）
 */
export function getFolderNameById(folderId) {
  for (const [tag, id] of Object.entries(TAG_FOLDER_MAP)) {
    if (id === folderId) return tag.replace(/^#|#$/g, '');
  }
  return folderId;
}

/**
 * 获取当前活跃账号信息（用于外部显示）
 */
export function getActiveAccountInfo() {
  const acc = getActiveAccount();
  if (!acc) return { configured: false };
  return {
    configured: true,
    name: acc.name,
    index: acc._index,
    total: IMA_ACCOUNTS.length,
  };
}

// ── 命令行入口 ──────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('ima-upload.mjs')) {
  const args = process.argv.slice(2);
  let filePath = '';
  let folderId = '';
  let dryRun = false;
  let showAccounts = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file': filePath = args[++i]; break;
      case '--folder': folderId = args[++i]; break;
      case '--dry-run': dryRun = true; break;
      case '--accounts': showAccounts = true; break;
      case '--help': case '-h':
        console.log(`IMA 文件上传模块（多账号轮换版）

用法:
  node scripts/ima-upload.mjs --file <path> --folder <folder_id> [选项]
  node scripts/ima-upload.mjs --accounts          # 查看账号列表和当前活跃账号

选项:
  --file <path>      本地文件路径
  --folder <id>      目标文件夹 ID
  --dry-run          预览模式，不实际上传
  --accounts         显示账号列表和当前活跃账号

多账号说明:
  config.json ima.accounts 数组配置多个 {name, clientId, apiKey}
  上传失败（限流/额度耗尽）自动切换下一账号重试
  活跃账号索引持久化到 ima-account-state.json

可用文件夹:
${Object.entries(TAG_FOLDER_MAP).map(([tag, id]) => `  ${tag} → ${id} (${tag.replace(/^#|#$/g, '')})`).join('\n')}
`);
        process.exit(0);
    }
  }

  if (showAccounts) {
    const info = getActiveAccountInfo();
    if (!info.configured) {
      console.log('❌ 未配置 IMA 账号');
    } else {
      console.log(`IMA 账号列表 (${info.total} 个):`);
      IMA_ACCOUNTS.forEach((acc, i) => {
        const active = i === info.index ? ' ← 当前活跃' : '';
        console.log(`  [${i}] ${acc.name}${active}`);
      });
    }
    process.exit(0);
  }

  if (!filePath || !folderId) {
    console.error('用法: node scripts/ima-upload.mjs --file <path> --folder <folder_id>');
    process.exit(1);
  }

  uploadFileToIma(filePath, folderId, { dryRun }).then(result => {
    if (result.success) {
      console.log(`\n✅ 上传成功${result.mediaId ? ` (media_id: ${result.mediaId})` : ''}${result.account ? ` [账号: ${result.account}]` : ''}`);
    } else {
      console.error(`\n❌ 上传失败: ${result.error}`);
      process.exit(1);
    }
  }).catch(e => {
    console.error(`\n❌ 异常: ${e.message}`);
    process.exit(1);
  });
}
