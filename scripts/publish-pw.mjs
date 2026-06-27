#!/usr/bin/env node
/**
 * Playwright 浏览器自动化发帖模块 v2.1
 *
 * 当 CLI upload_token 耗尽时，通过浏览器 UI 自动化完成文件上传和发帖。
 *
 * 🔑 认证方式（按优先级）:
 *   1. Persistent Profile — 首次 --login 登录一次，后续自动复用 cookie
 *   2. --cookie 参数 — 手动传入 cookie 字符串
 *   3. config.json — profiles.{name}.cookie
 *
 * 用法（模块导入）:
 *   import { publishViaPlaywright, loginViaPlaywright } from './scripts/publish-pw.mjs';
 *   // 首次登录（只需一次）
 *   await loginViaPlaywright({ groupId: '888...' });
 *   // 后续直接发帖，cookie 自动从 profile 加载
 *   const { topicId } = await publishViaPlaywright({ text, filePaths, groupId, useProfile: true });
 *
 * 用法（命令行）:
 *   node scripts/publish-pw.mjs --login                  # 首次登录，保存 profile
 *   node scripts/publish-pw.mjs --text "正文" --files "a.jpg,b.pdf"  # 发帖（自动用 profile）
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PROFILE_DIR = join(ROOT, '.playwright-profile');

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 从 config.json 读取配置 */
function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * 解析 cookie 字符串为 Playwright cookie 数组
 * 格式: "key1=val1; key2=val2; ..."
 */
function parseCookies(cookieStr, domain = '.zsxq.com') {
  if (!cookieStr) return [];
  return cookieStr.split(';').map(c => {
    const idx = c.indexOf('=');
    if (idx === -1) return null;
    return {
      name: c.substring(0, idx).trim(),
      value: c.substring(idx + 1).trim(),
      domain,
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    };
  }).filter(Boolean);
}

/** 确保目录存在 */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 生成时间戳字符串 */
function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 根据操作系统生成合适的 UserAgent */
const UA = process.platform === 'win32'
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── 认证层 ──────────────────────────────────────────────────────────────────

/**
 * 首次登录 — 打开有头浏览器，用户手动扫码/登录知识星球
 * 登录状态自动保存到 .playwright-profile/，后续发帖无需再提供 cookie。
 *
 * @param {Object} opts
 * @param {string} opts.groupId - 星球 ID（用于验证登录成功）
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function loginViaPlaywright({ groupId } = {}) {
  if (!groupId) {
    const config = loadConfig();
    const uploadProfile = config.profiles?.upload || {};
    groupId = groupId || uploadProfile.groupId;
  }
  if (!groupId) return { success: false, error: '缺少 groupId，无法验证登录' };

  console.log('🔑 打开浏览器，请手动登录知识星球...\n');

  // 删除旧 profile 确保全新登录
  // （如果想保留旧状态可以跳过这一步）
  ensureDir(PROFILE_DIR);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const page = context.pages()[0] || await context.newPage();

  // 导航到星球页面
  await page.goto(`https://wx.zsxq.com/dweb2/index/group/${groupId}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });

  console.log('  ⏳ 请在浏览器中完成登录（扫码或手机号）...');
  console.log('  ✅ 登录成功后，页面会自动刷新并显示星球内容');
  console.log('  🔒 登录状态将保存到 .playwright-profile/');
  console.log('  ⏹️  看到星球内容后，关闭浏览器窗口即可完成\n');

  // 等待用户登录成功（URL 不再是 login 页面）
  try {
    await page.waitForFunction(
      () => !window.location.href.includes('/login'),
      { timeout: 300000, polling: 2000 } // 5 分钟超时
    );
    console.log('  ✅ 检测到登录成功！');
    await page.waitForTimeout(2000);
  } catch {
    console.log('  ⚠️  超时未检测到登录，但 profile 已保存');
  }

  // 验证 cookie 是否已写入
  const cookies = await context.cookies();
  const token = cookies.find(c => c.name === 'zsxq_access_token');
  if (token) {
    console.log(`  🍪 zsxq_access_token: ${token.value.slice(0, 20)}...`);
    console.log('  ✅ Profile 已保存，后续发帖将自动使用此登录状态');
    await context.close();
    return { success: true, error: null };
  } else {
    console.log('  ⚠️  未检测到 zsxq_access_token，可能需要重新登录');
    await context.close();
    return { success: false, error: '未检测到 cookie，登录可能未完成' };
  }
}

/**
 * 使用 persistent profile 打开浏览器上下文
 * 返回 { context, page }，如果 profile 不存在或 cookie 过期则返回 null
 */
async function openWithProfile(headless) {
  if (!existsSync(PROFILE_DIR)) return null;

  try {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      viewport: { width: 1280, height: 900 },
      userAgent: UA,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const page = context.pages()[0] || await context.newPage();
    return { context, page };
  } catch (e) {
    console.error(`  ⚠️  打开 profile 失败: ${e.message}`);
    return null;
  }
}

// ── 核心发布函数 ────────────────────────────────────────────────────────────

/**
 * 通过 Playwright 浏览器自动化发布帖子（含文件上传）
 *
 * 认证优先级: useProfile → cookie → config.json cookie
 *
 * @param {Object} opts
 * @param {string}  opts.text      - 正文内容
 * @param {string[]} opts.filePaths - 本地文件路径数组
 * @param {string}  opts.cookie    - Cookie 字符串（手动指定，优先级高于 profile）
 * @param {string}  opts.groupId   - 目标星球 ID
 * @param {boolean} [opts.useProfile=true] - 是否使用 persistent profile 自动认证
 * @param {boolean} [opts.headless=true] - 是否无头模式
 * @param {boolean} [opts.interactive=false] - 交互模式
 * @param {number}  [opts.timeout=60000] - 总超时时间(ms)
 * @returns {Promise<{topicId: string|null, error: string|null}>}
 */
export async function publishViaPlaywright({
  text,
  filePaths = [],
  cookie,
  groupId,
  useProfile = true,
  headless = true,
  interactive = false,
  timeout = 60000,
}) {
  // 参数校验
  if (!groupId) return { topicId: null, error: '缺少 groupId' };
  if (!interactive && !text) return { topicId: null, error: '缺少正文 text' };

  const debugDir = join(ROOT, '.playwright-debug');
  ensureDir(debugDir);

  let browser, context, page;
  let usedProfile = false;

  // 统一关闭逻辑
  const closeSession = async () => {
    if (usedProfile) {
      await context?.close();
    } else {
      await browser?.close();
    }
  };

  // ── 认证策略：profile 优先 → cookie 回退 ──
  if (!cookie && useProfile) {
    const prof = await openWithProfile(headless);
    if (prof) {
      ({ context, page } = prof);
      usedProfile = true;
      console.log(`  🔑 认证: Persistent Profile (.playwright-profile/)`);
    }
  }

  if (!context) {
    // cookie 模式
    if (!cookie) {
      // 尝试从 config 读取
      const config = loadConfig();
      const uploadProfile = config.profiles?.upload || config.profiles?.account1 || {};
      const fetchProfile = config.profiles?.fetch || config.profiles?.account2 || {};
      cookie = uploadProfile.cookie || fetchProfile.cookie || '';
    }
    if (!cookie) {
      return {
        topicId: null,
        error: '无可用认证方式。请先运行 node scripts/publish-pw.mjs --login 登录，或通过 --cookie 参数传入',
      };
    }

    console.log(`  🔑 认证: Cookie 字符串（config.json）`);
    browser = await chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: UA,
    });

    const cookies = parseCookies(cookie);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
    page = await context.newPage();
  }

  // —— 网络请求监听（用于交互模式捕获请求） ——
  let capturedRequests = [];
  if (interactive) {
    page.on('request', req => {
      if (req.url().includes('api.zsxq.com') || req.url().includes('zsxq.com/v')) {
        capturedRequests.push({
          url: req.url(),
          method: req.method(),
          headers: req.headers(),
          postData: req.postData(),
          timestamp: Date.now(),
        });
      }
    });
    page.on('response', async resp => {
      const req = resp.request();
      if (req.url().includes('api.zsxq.com') || req.url().includes('zsxq.com/v')) {
        const entry = capturedRequests.find(r => r.url === req.url() && !r.response);
        if (entry) {
          try {
            entry.responseStatus = resp.status();
            entry.responseBody = await resp.text().catch(() => '[binary]');
          } catch {}
        }
      }
    });
  }

  try {
    // 1. 导航到星球页面（验证登录状态）
    const groupUrl = `https://wx.zsxq.com/dweb2/index/group/${groupId}`;
    console.log(`  🌐 导航: ${groupUrl}`);
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 检测是否仍在登录页
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      const screenshotPath = join(debugDir, `login-redirect-${ts()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const closeHint = usedProfile
        ? 'Profile cookie 已过期，请运行 node scripts/publish-pw.mjs --login 重新登录'
        : 'Cookie 无效或已过期，请运行 node scripts/publish-pw.mjs --login 通过浏览器登录';
      await closeSession();
      return { topicId: null, error: `${closeHint}\n截图: ${screenshotPath}` };
    }

    // 检测 group 页面是否加载成功
    const groupIndicator = page.locator('.group-detail, .group-info, .feed, .topics, [class*="topic"], [class*="feed"]').first();
    try {
      await groupIndicator.waitFor({ timeout: 10000 });
    } catch {
      // 可能页面结构不同，不强制失败
      console.log(`  ⚠️  未检测到标准星球页面结构，继续尝试...`);
    }

    if (interactive) {
      // 交互模式：等待用户手动操作，然后捕获请求
      console.log(`\n  🔍 交互模式已启动 — 请在浏览器中手动完成发帖操作`);
      console.log(`  📋 网络请求将被自动捕获`);
      console.log(`  ⏳ 等待操作完成（最多 ${timeout / 1000} 秒）...\n`);

      try {
        await page.waitForFunction(
          () => {
            // 检测 URL 变为 topic 详情页
            return window.location.href.includes('/topic/');
          },
          { timeout, polling: 1000 }
        );
      } catch {
        console.log('  ⚠️  超时未检测到 topic 页面跳转');
      }

      // 保存捕获的请求
      const capturedFile = join(debugDir, `captured-requests-${ts()}.json`);
      const topicRelated = capturedRequests.filter(r =>
        r.url.includes('/topics') || r.url.includes('/upload') || r.url.includes('/files')
      );
      const cwd = process.cwd().replace(/\\/g, '/');
      const simplified = topicRelated.map(r => ({
        ...r,
        responseBody: r.responseBody?.length > 500
          ? r.responseBody.slice(0, 500) + `... [总长${r.responseBody.length}字符]`
          : r.responseBody,
        replayCmd: `curl -X ${r.method} '${r.url}' ${Object.entries(r.headers || {}).filter(([k]) => !['cookie','host','content-length'].includes(k.toLowerCase())).map(([k, v]) => `-H '${k}: ${v}'`).join(' ')} ${r.postData ? `-d '${r.postData.replace(/'/g, "'\\''")}'` : ''}`,
      }));
      const report = {
        capturedAt: new Date().toISOString(),
        totalRequests: capturedRequests.length,
        topicRelated: simplified,
        savedTo: capturedFile,
      };
      console.log(`\n  📊 捕获到 ${capturedRequests.length} 个 API 请求`);
      console.log(`  📁 主题相关: ${topicRelated.length} 个`);
      console.log(`  📄 详情已保存: ${capturedFile}`);

      const topicMatch = page.url().match(/topic[\/=](\d+)/);
      const topicId = topicMatch ? topicMatch[1] : null;
      const screenshotPath = join(debugDir, `interactive-${ts()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await closeSession();
      return { topicId, error: null, capturedRequests: report };
    }

    // 2. 内联发帖：点击 post-container 激活编辑器，无需跳转页面
    console.log(`  📝 激活内联发帖编辑器...`);

    // 点击发帖区域激活
    const postContainer = page.locator('.post-container, .post-topic-head').first();
    try {
      await postContainer.waitFor({ state: 'visible', timeout: 5000 });
      await postContainer.click();
      await page.waitForTimeout(1000);
      console.log(`  ✅ 编辑器已激活`);
    } catch {
      console.log(`  ⚠️  未找到 post-container，继续尝试...`);
    }



    // 3. 填入正文 — 知识星球内联编辑器
    const editorSelectors = [
      '[contenteditable="true"]',
      '.post-content textarea',
      'textarea',
      '[role="textbox"]',
      '.ql-editor',
      '.post-container [contenteditable]',
      '.post-topic-head [contenteditable]',
    ];

    let editorFound = false;
    for (const sel of editorSelectors) {
      const el = page.locator(sel).first();
      try {
        await el.waitFor({ state: 'visible', timeout: 3000 });
        await el.click();
        await page.waitForTimeout(300);
        await el.fill(text);
        editorFound = true;
        console.log(`  ✍️  正文已填入 (${text.length} 字, 选择器: ${sel})`);
        break;
      } catch { continue; }
    }

    if (!editorFound) {
      // 尝试点击容器后直接用键盘输入
      console.log('  ⚠️  未找到专用编辑器，尝试容器内输入...');
      try {
        await postContainer.click();
        await page.waitForTimeout(500);
        await page.keyboard.type(text, { delay: 10 });
        editorFound = true;
      } catch {
        console.log('  ⚠️  键盘输入也失败');
      }
    }

    // 4. 上传文件 — 知识星球使用 ".post-topic-footer" 中的按钮
    let uploadSuccess = [];
    if (filePaths.length > 0) {
      console.log(`  📎 准备上传 ${filePaths.length} 个文件...`);

      for (const fp of filePaths) {
        if (!existsSync(fp)) {
          console.log(`     ⚠️  文件不存在: ${fp}`);
          continue;
        }
        const fname = basename(fp);
        const ext = extname(fp).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext);

        try {
          // 查找隐藏的 file input（知识星球在 post-topic-footer 中）
          const fileInput = page.locator('input[type="file"]').first();
          const fileInputCount = await page.locator('input[type="file"]').count();

          if (fileInputCount > 0) {
            try {
              await fileInput.setInputFiles(fp);
              await page.waitForTimeout(3000);
              console.log(`     ✅ ${fname} (直接设置文件, ${isImage ? '图片' : '附件'})`);
              uploadSuccess.push(fp);
              continue;
            } catch (e) {
              console.log(`     ⚠️  直接上传失败: ${e.message.slice(0, 40)}`);
            }
          }

          // 策略 B: 点击添加文件按钮触发 filechooser
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 5000 }),
            (async () => {
              // 知识星球按钮：普通文件（pdf/doc/...）或 添加图片
              const attachBtn = page.locator(isImage
                ? '.post-topic-footer:has-text("添加图片"), [class*="add-image"], [class*="add-img"]'
                : '.post-topic-footer:has-text("普通文件"), .post-topic-footer:has-text("添加图片")'
              ).first();
              try {
                if ((await attachBtn.count()) > 0) {
                  await attachBtn.click({ timeout: 2000 });
                }
              } catch {}
            })(),
          ]).catch(() => [null]);

          if (fileChooser) {
            await fileChooser.accept([fp]);
            await page.waitForTimeout(3000);
            console.log(`     ✅ ${fname} (文件选择器)`);
            uploadSuccess.push(fp);
          } else {
            console.log(`     ❌ ${fname} (无法触发上传，所有方式均失败)`);
          }

        } catch (e) {
          console.log(`     ❌ ${fname} 上传失败: ${e.message}`);
        }

        if (filePaths.indexOf(fp) < filePaths.length - 1) {
          await page.waitForTimeout(2000);
        }
      }
      console.log(`  📎 上传完成: ${uploadSuccess.length}/${filePaths.length}`);
    }

    // 等待页面稳定
    await page.waitForTimeout(2000);

    // 5. 提交发布 — 监听网络请求捕获 topic_id
    // 创建 API 响应监听
    let newTopicId = null;
    const respPromise = new Promise((resolve) => {
      page.on('response', async (resp) => {
        const url = resp.request().url();
        if (url.includes('api.zsxq.com') && (url.includes('/topics') || url.includes('create'))) {
          try {
            const body = await resp.text().catch(() => '');
            const m = body.match(/"topic_id"\s*:\s*"?(\d+)"?/);
            if (m) {
              newTopicId = m[1];
              console.log(`  📡 API 返回 topic_id: ${newTopicId}`);
              resolve(newTopicId);
            }
          } catch {}
        }
      });
      // 超时回退
      setTimeout(() => resolve(null), 10000);
    });

    const submitSelectors = [
      '.submit-btn',
      'div.submit-btn',
      '.post-topic-btn .submit-btn',
      'button:has-text("发布")',
      'button:has-text("发表")',
      '[type="submit"]',
      '.publish-btn',
      'button[class*="publish"]',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      try {
        const cnt = await btn.count();
        if (cnt > 0) {
          await btn.waitFor({ state: 'visible', timeout: 3000 });
          await btn.click();
          console.log(`  🚀 已点击发布 (选择器: ${sel})`);
          submitted = true;
          break;
        }
      } catch { continue; }
    }

    if (!submitted) {
      const screenshotPath = join(debugDir, `no-submit-btn-${ts()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await closeSession();
      return { topicId: null, error: `未找到发布按钮，截图: ${screenshotPath}` };
    }

    // 等待 API 返回 topic_id
    const apiTopicId = await respPromise;
    if (apiTopicId) {
      console.log(`  ✅ 发布成功! topic_id: ${apiTopicId}`);
      await closeSession();
      return { topicId: apiTopicId, error: null };
    }

    // 6. 等待发布完成并提取 topic_id
    // 等分享对话框出现
    await page.waitForTimeout(2000);

    // 🔍 提取分享弹窗中的 topic_id
    const topicFromShare = await page.evaluate(() => {
      // 分享弹窗中的输入框（通常包含 topic 链接）
      const inputs = document.querySelectorAll('.share-wrapper input, .share-wrapper textarea, .share-topic input, [class*="share"] input');
      for (const inp of inputs) {
        const val = inp.value || '';
        const m = val.match(/topic[/=](\d+)/);
        if (m) return m[1];
      }
      // 查找分享弹窗内的链接
      const links = document.querySelectorAll('.share-wrapper a, .share-topic a, [class*="share"] a');
      for (const a of links) {
        const m = (a.href || '').match(/topic[/=](\d+)/);
        if (m) return m[1];
      }
      // 检查所有包含 topic 数字的文本
      const allText = document.querySelector('.share-wrapper, .share-topic')?.innerText || '';
      const m2 = allText.match(/\b(\d{10,})\b/);
      return m2 ? m2[1] : null;
    });
    if (topicFromShare) {
      console.log(`  ✅ 发布成功! topic_id: ${topicFromShare} (来源: 分享弹窗)`);
      await closeSession();
      return { topicId: topicFromShare, error: null };
    }
    await page.waitForTimeout(2000);

    // 从 URL 提取
    const finalUrl = page.url();
    const topicMatch = finalUrl.match(/topic[\/=](\d+)/);
    if (topicMatch) {
      console.log(`  ✅ 发布成功! topic_id: ${topicMatch[1]} (来源: URL)`);
      await closeSession();
      return { topicId: topicMatch[1], error: null };
    }

    // 从页面内容提取 topic_id
    const pageContent = await page.content();
    const idPatterns = [
      /topic_id["\s:=]+(\d+)/,
      /topicId["\s:=]+(\d+)/,
      /"topic_id"\s*:\s*"?(\d+)"?/,
      /\/topics\/(\d+)/,
    ];
    for (const pattern of idPatterns) {
      const match = pattern.exec(pageContent);
      if (match) {
        const topicId = match[1];
        console.log(`  ✅ 发布成功! topic_id: ${topicId} (来源: 页面内容)`);
        await closeSession();
        return { topicId, error: null };
      }
    }

    // 从 toast/弹窗/分享对话框 提取 topic_id
    try {
      // 分享对话框内容
      const shareInfo = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('.dialog, .modal, .share-dialog, [class*="share"]');
        for (const d of dialogs) {
          const text = d.textContent || '';
          const links = d.querySelectorAll('a[href*="topic"], input[value*="topic"]');
          const hrefs = Array.from(links).map(a => a.href || a.value || '');
          return { text: text.slice(0, 200), hrefs };
        }
        return null;
      });
      if (shareInfo) {
        for (const h of shareInfo.hrefs) {
          const m = h.match(/topic[\/=](\d+)/);
          if (m) {
            console.log(`  ✅ 发布成功! topic_id: ${m[1]} (来源: 分享链接)`);
            await closeSession();
            return { topicId: m[1], error: null };
          }
        }
      }
    } catch {}

    // 从页面所有链接提取最新 topic_id
    try {
      const allTopics = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/topic/"]');
        return Array.from(links).slice(0, 5).map(a => {
          const m = a.href.match(/topic\/(\d+)/);
          return m ? m[1] : null;
        }).filter(Boolean);
      });
      if (allTopics.length > 0) {
        const newest = allTopics[0];
        console.log(`  ✅ 发布成功! topic_id: ${newest} (来源: 页面链接)`);
        await closeSession();
        return { topicId: newest, error: null };
      }
    } catch {}

    // 检查编辑器是否已清空（发布成功的标志）
    const editorEmpty = await page.evaluate(() => {
      const editor = document.querySelector('.ql-editor');
      return editor && editor.textContent.trim().length === 0;
    });
    if (editorEmpty) {
      console.log('  ✅ 发布成功（编辑器已清空，topic_id 未能提取）');
      await closeSession();
      return { topicId: null, error: null };
    }

    console.log('  ⚠️  未能确认发布状态');

    // 截图调试
    const screenshotPath = join(debugDir, `publish-result-${ts()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`  📸 结果截图: ${screenshotPath}`);

    await closeSession();
    return { topicId: null, error: null }; // 不是失败，只是未能确认

  } catch (e) {
    const screenshotPath = join(debugDir, `error-${ts()}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {}
    await closeSession();
    console.error(`  ❌ Playwright 异常: ${e.message}`);
    return { topicId: null, error: `Playwright 异常: ${e.message}\n截图: ${screenshotPath}` };
  }
}

// ── 命令行入口 ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] && (() => {
  const entry = process.argv[1].replace(/\\/g, '/');
  const self = import.meta.url.replace(/^file:\/\//, '').replace(/\\/g, '/');
  return entry === self || entry.endsWith(self.split('/').slice(-2).join('/'));
})();

if (isMain) {
  const config = loadConfig();

  // 解析参数
  const args = process.argv.slice(2);
  let text, files = [], cookie, groupId, interactive = false, headless = true, login = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--text':
        text = args[++i];
        break;
      case '--files':
        files = args[++i].split(',').map(f => f.trim()).filter(Boolean);
        break;
      case '--cookie':
        cookie = args[++i];
        break;
      case '--group-id':
        groupId = args[++i];
        break;
      case '--interactive':
        interactive = true;
        break;
      case '--headed':
        headless = false;
        break;
      case '--login':
        login = true;
        break;
      case '--help':
      case '-h':
        console.log(`publish-pw.mjs — Playwright 浏览器自动化发帖 v2.1

🔑 认证方式（自动选择，无需手动关心）:
  1. Persistent Profile — 首次 --login 浏览器登录一次，后续自动复用
  2. --cookie 参数 — 手动传入 cookie 字符串
  3. config.json — profiles.{name}.cookie

用法:
  node scripts/publish-pw.mjs [选项]

选项:
  --login             首次登录：打开浏览器，手动扫码/手机号登录，保存 profile
  --text <正文>       帖子正文内容
  --files <路径>      文件路径，逗号分隔（如 "a.jpg,b.pdf"）
  --cookie <cookie>   手动指定 Cookie（优先于 profile）
  --group-id <id>     目标星球 ID
  --interactive       交互模式：手动发帖并捕获 API 请求
  --headed            有头模式（显示浏览器窗口）
  --help, -h          显示帮助

示例:
  # 首次登录（只需一次！）
  node scripts/publish-pw.mjs --login

  # 登录后直接发帖（cookie 自动加载）
  node scripts/publish-pw.mjs --text "测试内容" --group-id 88882114281542

  # 带文件发帖
  node scripts/publish-pw.mjs --text "带图测试" --files "a.jpg,b.pdf"
`);
        process.exit(0);
    }
  }

  // 从配置填充默认值
  const uploadProfile = config.profiles?.upload || config.profiles?.account1 || {};
  const fetchProfile = config.profiles?.fetch || config.profiles?.account2 || {};
  if (!groupId) groupId = uploadProfile.groupId || '';

  // ── login 模式 ──
  if (login) {
    if (!groupId) {
      console.error('❌ --login 需要 --group-id 或在 config.json 中配置 groupId');
      process.exit(1);
    }
    const result = await loginViaPlaywright({ groupId });
    if (result.success) {
      console.log('\n✅ 登录成功！Profile 已保存到 .playwright-profile/');
      console.log('后续发帖无需再提供 cookie');
    } else {
      console.error(`\n⚠️  ${result.error}`);
    }
    process.exit(result.success ? 0 : 1);
  }

  if (!cookie) cookie = uploadProfile.cookie || fetchProfile.cookie || '';

  if (interactive) {
    // 交互模式
    console.log('🔍 Playwright 交互模式');
    console.log(`   groupId: ${groupId || '(需手动指定)'}`);
    console.log(`   cookie: ${cookie ? '已提供' : '未提供（将手动登录）'}\n`);

    if (!groupId) {
      console.error('❌ 交互模式需要 --group-id');
      process.exit(1);
    }

    const result = await publishViaPlaywright({
      text: '', filePaths: [], cookie, groupId, headless: false, interactive: true, timeout: 300000,
    });
    if (result.topicId) {
      console.log(`\n✅ 发布完成! topic_id: ${result.topicId}`);
    }
    if (result.capturedRequests) {
      console.log(`📋 API 请求已捕获（用于签名逆向）`);
    }
  } else {
    // 正常发布模式
    if (!text) {
      console.error('❌ 请提供 --text 参数');
      process.exit(1);
    }
    if (!groupId) {
      console.error('❌ 请提供 --group-id 或在 config.json 中配置');
      process.exit(1);
    }

    // 验证文件存在
    for (const f of files) {
      if (!existsSync(f)) {
        console.error(`❌ 文件不存在: ${f}`);
        process.exit(1);
      }
    }

    console.log(`📤 Playwright 浏览器发帖`);
    console.log(`   星球: ${groupId}`);
    console.log(`   正文: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
    console.log(`   文件: ${files.length > 0 ? files.join(', ') : '(无)'}`);
    console.log(`   模式: ${headless ? '无头' : '有头'}\n`);

    const result = await publishViaPlaywright({ text, filePaths: files, cookie, groupId, headless });

    if (result.topicId) {
      console.log(`\n✅ 发布成功!`);
      console.log(`   topic_id: ${result.topicId}`);
      console.log(`   链接: https://wx.zsxq.com/dweb2/index/topic/${result.topicId}`);
      process.exit(0);
    } else if (result.error) {
      console.error(`\n❌ 发布失败: ${result.error}`);
      process.exit(1);
    } else {
      console.log(`\n⚠️ 发布可能已成功，但未能提取 topic_id，请检查截图`);
      process.exit(1);
    }
  }
}
