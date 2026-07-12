#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { captureCommentShot as captureCommentShotUtil } from './shot-utils.mjs';
import { createStorage } from './storage.mjs';
import { builtinVideoList, builtinComments, openXhsNoteViaProfile } from './collectors-builtin.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const args = new Set(process.argv.slice(2));
const argValue = (name, fallback = null) => {
  const found = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : fallback;
};

const runtimeDir = path.join(__dirname, '.runtime');
const profileDir = path.resolve(__dirname, config.runtime.profileDir);
const runLockPath = path.join(runtimeDir, 'run.lock.json');
const progressPath = path.join(runtimeDir, 'progress.json');
const stopRequestedPath = path.join(runtimeDir, 'stop-requested.json');
const loginStatusPath = path.join(runtimeDir, 'login-status.json');
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const runId = `radar-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
let storage = null; // 在 main() 里按 config.storage.mode 初始化（local 默认开箱即用 / feishu 绑定后完全体）
const dryRun = args.has('--dry-run');
const loginCheck = args.has('--login-check');
const loginSetup = args.has('--login-setup');
const fastTest = args.has('--fast-test');
const limitCreators = Number(argValue('--limit-creators', '0')) || 0;
const onlyPlatform = argValue('--only-platform', '');
const fastSettleMs = Number(argValue('--settle-ms', '0')) || 0; // fast-test 下覆盖页面渲染停顿(B站 shadow DOM 等需要更久)
// 历史回填模式：解开「每博主1条/每轮上限」，抓全列表，可按年份过滤、按名字匹配博主。慢节奏跑，靠去重可断点续抓
const backfill = args.has('--backfill');
const yearFilter = argValue('--year', '');
const creatorMatch = argValue('--creator-match', '');
const limitNew = Number(argValue('--limit-new', '0')) || 0; // 限制本轮最多入库 N 条新内容(测试/小步验证用)，回填模式也生效
const maxNotesOverride = Number(argValue('--max-notes', '0')) || 0;
const effectiveMaxNotes = maxNotesOverride || (backfill ? 80 : (config.runtime.maxCreatorNotes || 5));
const skipComments = args.has('--skip-comments');
const headless = args.has('--headless') ? true : Boolean(config.runtime.headless);
const delays = config.runtime.delays || {};
const closeExistingProfile = args.has('--no-close-profile') ? false : config.runtime.closeExistingProfileBeforeRun !== false;
// 小红书是国内站，默认直连，避开系统代理隧道抖动导致的 ERR_TUNNEL_CONNECTION_FAILED。
// 实测 Playwright proxy:{server:'direct://'} 在本机 channel:chrome 下反而 ERR_PROXY_CONNECTION_FAILED，
// 改用 Chrome 原生 --no-proxy-server 强制直连(实测 goto 小红书 200)。
// 走代理时设 config.runtime.directConnect=false 继承系统代理，或在 config.runtime.proxy 配 { server, bypass }。
const browserProxy = config.runtime.proxy !== undefined && config.runtime.proxy !== null ? config.runtime.proxy : null;
const directConnect = config.runtime.proxy === undefined && config.runtime.directConnect !== false;
// --noerrdialogs 等三参数压掉「打开您的个人资料时出了点问题」和崩溃恢复弹窗(采集专用 profile 被强杀后会留崩溃标记)
const launchArgs = ['--disable-blink-features=AutomationControlled', '--noerrdialogs', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'];
if (directConnect) launchArgs.push('--no-proxy-server');

const loginPlatform = argValue('--platform', 'xiaohongshu');

// 可选增强采集脚本（浏览器插件类内容脚本）按需加载：config.collectors.meixun.platforms 配了才用，
// 路径支持相对(相对本项目目录)或绝对。没配就全部走内置 DOM 采集器(collectors-builtin.mjs)，下载即用。
function loadPlatformScripts() {
  const cache = {};
  const platforms = config.collectors?.meixun?.platforms || config.meixun?.platforms;
  if (platforms) {
    const resolveScript = (p) => (path.isAbsolute(p) ? p : path.join(__dirname, p));
    for (const [name, paths] of Object.entries(platforms)) {
      // 单平台脚本缺失不连累其它平台：该平台自动回落内置采集器
      try {
        cache[name] = {
          userVideo: fs.readFileSync(resolveScript(paths.userVideoScript), 'utf8'),
          comment: fs.readFileSync(resolveScript(paths.commentScript), 'utf8')
        };
      } catch (error) {
        console.error(`[采集器] ${name} 增强脚本加载失败，回落内置 DOM 采集器：${String(error.message).split('\n')[0]}`);
      }
    }
  }
  return cache;
}
const platformScripts = loadPlatformScripts();

// 平台适配表：把三平台的消息类型/登录墙正则/字段归一化差异收敛成纯数据。归一化函数声明在下方(已 hoist)。
const PLATFORM = {
  xiaohongshu: {
    label: '小红书',
    home: 'https://www.xiaohongshu.com/explore',
    collectVideosType: 'COLLECT_USER_NOTES',
    videoTaskInfo: { feature: 'note', method: 'creatorNote' },
    commentType: 'COLLECT_NOTE_COMMENT',
    commentTaskInfo: { feature: 'comment', method: 'noteComment' },
    // 回填强制关详情：fetchDetail=true 逐条进详情页(12s+/条)，大列表必超时→静默0条(实测40条列表踩过坑)；正文列回填批次留空可接受
    fetchDetail: () => (backfill ? false : Boolean(config.runtime.fetchNoteDetail)),
    extraVideoPayload: {},
    extraCommentPayload: {},
    profileLoginWall: /登录即可查看|手机号登录|获取验证码/,
    loginWall: /手机号登录|获取验证码/,
    loginCheckWall: /手机号登录|登录即可查看|获取验证码|扫码/,
    commentFailViaDone: true,
    normalizeId: (r) => normalizeNoteIdXhs(r),
    normalizeUrl: (r) => normalizeVideoUrlXhs(r),
    // includeAllNoteTypes=true 时视频+图文笔记全收，否则只收视频笔记(旧标准)
    isVideo: (r) => config.runtime.includeAllNoteTypes ? true : isVideoNoteXhs(r)
  },
  douyin: {
    label: '抖音',
    home: 'https://www.douyin.com/',
    collectVideosType: 'COLLECT_USER_VIDEOS',
    videoTaskInfo: { feature: 'video', method: 'creatorVideo' },
    commentType: 'COLLECT_COMMENTS',
    commentTaskInfo: { feature: 'comment', method: 'videoComment' },
    fetchDetail: () => false,
    extraVideoPayload: {},
    extraCommentPayload: {},
    profileLoginWall: /登录后观看|登录后查看|扫码登录|立即登录|登录抖音/,
    loginWall: /登录后查看|扫码登录|验证码登录|立即登录|登录抖音/,
    loginCheckWall: /扫码登录|验证码登录|立即登录|登录抖音/,
    loginCookie: /^(sessionid_ss|sessionid|sid_guard|passport_auth_status)$/,
    loginRequired: true, // 抖音必须登录(登出主页能看视频列表但评论拿不到)，cookie 缺失即抛错；B站不设=游客可抓
    customVideoList: 'douyin', // 媒讯抖音 user_video 选择器已随改版失效，改直抓 DOM 的 /video/ 链接
    commentFailViaDone: false,
    normalizeId: (r) => String(r.videoId || ''),
    normalizeUrl: (r) => String(r.url || ''),
    isVideo: () => true
  },
  bilibili: {
    label: 'B站',
    home: 'https://www.bilibili.com/',
    collectVideosType: 'COLLECT_USER_VIDEOS',
    videoTaskInfo: { feature: 'video', method: 'creatorVideo' },
    commentType: 'COLLECT_BILIBILI_COMMENT',
    commentTaskInfo: { feature: 'comment', method: 'bilibiliComment' },
    fetchDetail: () => false,
    extraVideoPayload: { filters: { sortBy: 'latest' } },
    extraCommentPayload: { replyLevel: 0 },
    profileLoginWall: /请完成安全验证/,
    loginWall: /请完成安全验证/,
    loginCheckWall: /请完成安全验证/,
    loginCookie: /^SESSDATA$/,
    commentFailViaDone: false,
    normalizeId: (r) => String(r.videoId || ''),
    normalizeUrl: (r) => String(r.url || ''),
    isVideo: () => true
  }
};
function platformOf(creator) {
  return PLATFORM[creator?.platform] || PLATFORM.xiaohongshu;
}
// 该平台配了增强脚本就用，否则返回 null 走内置 DOM 采集器
function scriptsOf(platform) {
  return platformScripts[platform] || null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRunLock() {
  try {
    return JSON.parse(fs.readFileSync(runLockPath, 'utf8'));
  } catch {
    return null;
  }
}

function releaseRunLock() {
  const lock = readRunLock();
  if (!lock || lock.pid !== process.pid) return;
  fs.rmSync(runLockPath, { force: true });
}

// 博主级颗粒度进度快照：仅在进入下一个 creator 循环体时写入，不做阶段级埋点
// currentCreatorPlatform 给工作台高亮当前博主用：存在双平台同名博主，只按名字高亮会串行
function writeProgress(currentCreatorIndex, currentCreatorName, totalCreators, startedAt, currentCreatorPlatform) {
  try {
    fs.writeFileSync(progressPath, JSON.stringify({
      runId,
      currentCreatorIndex,
      currentCreatorName,
      currentCreatorPlatform: currentCreatorPlatform || 'xiaohongshu',
      totalCreators,
      startedAt,
      lastUpdateAt: now()
    }, null, 2));
  } catch {
  }
}

function clearProgress() {
  fs.rmSync(progressPath, { force: true });
}

// 停止标记：仅在博主间隙检查，不做视频级检查点，读到即优雅退出，不强杀
function isStopRequested() {
  return fs.existsSync(stopRequestedPath);
}

function clearStopRequested() {
  fs.rmSync(stopRequestedPath, { force: true });
}

// 登录态健康快照：工作台登录健康卡片的唯一数据源，按 platform 合并覆盖(单文件数组)
function writeLoginStatus(platform, ok) {
  try {
    let list = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(loginStatusPath, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch {}
    list = list.filter((e) => e && e.platform !== platform);
    list.push({ platform, ok, checkedAt: now() });
    fs.writeFileSync(loginStatusPath, JSON.stringify(list, null, 2));
  } catch (err) {
    console.warn(`[登录态] 写 login-status.json 失败(不影响主流程): ${err.message}`);
  }
}

function acquireRunLock() {
  // {flag:'wx'} 原子抢锁：读后写有秒级窗口(启动加载期)，工作台连点两次会双跑抢同一 profile。
  // EEXIST 时读锁判活：持有者活着就报错，死锁(stale)删掉重抢一次。
  const payload = () => JSON.stringify({
    pid: process.pid,
    runId,
    startedAt: now(),
    argv: process.argv.slice(2)
  }, null, 2);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(runLockPath, payload(), { flag: 'wx' });
      // 拿锁成功即清陈旧停止标记：上一轮被 SIGKILL/断电没走 finally 时标记会残留，
      // 不清的话本轮跑完第一个博主就被旧标记优雅退出，日志还记"成功"
      clearStopRequested();
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // 读锁判活。半写文件(刚 wx 创建还没写内容)会 parse 成 null，短暂重读几次，
      // 别把正在写的活锁误删导致两个进程同时拿锁(TOCTOU)
      let lock = readRunLock();
      for (let r = 0; r < 3 && lock === null; r += 1) { sleepSync(150); lock = readRunLock(); }
      const ageMs = lock && lock.startedAt ? (Date.now() - Date.parse(String(lock.startedAt).replace(' ', 'T'))) : 0;
      const tooOld = ageMs > 24 * 3600 * 1000; // 超 24h 视为残锁(PID 可能已被系统复用)，避免永久静默空跑
      if (lock && Number.isFinite(lock.pid) && lock.pid !== process.pid && processExists(lock.pid) && !tooOld) {
        const lockErr = new Error(`已有监控任务在运行。pid=${lock.pid} startedAt=${lock.startedAt}。请等待当前任务结束后再重试，避免抢占同一 Chrome profile。`);
        lockErr.code = 'RUN_LOCK_HELD';
        throw lockErr;
      }
      fs.rmSync(runLockPath, { force: true });
    }
  }
  const lockErr = new Error('抢锁两次仍失败(锁文件被并发反复创建)，放弃本次运行。');
  lockErr.code = 'RUN_LOCK_HELD';
  throw lockErr;
}

function closeExistingProfileProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) return;
  const pids = result.stdout
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter(Boolean)
    .filter((item) => {
      if (!Number.isFinite(item.pid) || item.pid === process.pid) return false;
      if (!item.command.includes(profileDir)) return false;
      return item.command.includes('Google Chrome') || item.command.includes('chrome');
    })
    .map((item) => item.pid);

  const uniquePids = [...new Set(pids)];
  if (uniquePids.length === 0) return;

  console.log(`[浏览器准备] 关闭采集专用 Chrome profile 占用进程：${uniquePids.join(',')}`);
  for (const pid of uniquePids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
    }
  }
  sleepSync(3000);
  for (const pid of uniquePids) {
    if (!processExists(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
  sleepSync(1000);
}

function clearStaleSingletonLocks() {
  // Chrome crash/被 SIGKILL 后会在 profile 留下 Singleton 锁，导致下次 launchPersistentContext 卡死。
  // 调用前已 acquireRunLock + closeExistingProfileProcesses，确保没有活进程在用该 profile，可安全清。
  for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(profileDir, lockName), { force: true });
    } catch {
    }
  }
}

function isContextClosedError(error) {
  const text = String(error?.message || error || '');
  return /Target page, context or browser has been closed|browser has been closed|Browser closed|context.*closed/i.test(text);
}

// 启动前把上次崩溃标记复位：Chrome 被强杀后 Preferences 留 exit_type=Crashed，
// 下次启动就弹「打开您的个人资料时出了点问题」。每次 launch 前改回 Normal 即永不弹。
function resetCrashFlags() {
  try {
    const prefPath = path.join(profileDir, 'Default', 'Preferences');
    if (!fs.existsSync(prefPath)) return;
    const prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    if (prefs.profile) {
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;
      fs.writeFileSync(prefPath, JSON.stringify(prefs));
    }
  } catch {
  }
}

async function launchContextWithRetry() {
  resetCrashFlags();
  const launchers = [
    // deviceScaleFactor=2：截图按 2 倍物理像素渲染(2880x2000)，飞书附件是发文配图素材，清晰度优先
    () => chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless,
      ...(browserProxy ? { proxy: browserProxy } : {}),
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
      args: launchArgs
    }),
    () => chromium.launchPersistentContext(profileDir, {
      headless,
      ...(browserProxy ? { proxy: browserProxy } : {}),
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
      args: launchArgs
    })
  ];

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) {
      console.log('[浏览器恢复] 检测到专用 profile 可能仍被占用，重新清理旧进程后重试启动');
      closeExistingProfileProcesses();
      clearStaleSingletonLocks();
      sleepSync(2000);
    }
    for (const launch of launchers) {
      try {
        const context = await launch();
        context.on('close', () => {
          console.log('[浏览器恢复] 采集浏览器上下文已关闭');
        });
        return context;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError;
}

async function ensureContext(currentContext) {
  if (currentContext) {
    try {
      const page = await currentContext.newPage();
      await page.close().catch(() => {});
      return currentContext;
    } catch (error) {
      if (!isContextClosedError(error)) throw error;
      await currentContext.close().catch(() => {});
      console.log('[浏览器恢复] 检测到浏览器上下文已失效，准备重启专用 Chrome');
    }
  }
  return await launchContextWithRetry();
}

async function withContextRecovery(getContext, setContext, label, worker) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let context = await ensureContext(getContext());
    if (context !== getContext()) {
      setContext(context);
    }
    try {
      return await worker(context);
    } catch (error) {
      lastError = error;
      if (!isContextClosedError(error) || attempt === 2) {
        throw error;
      }
      console.log(`[浏览器恢复] ${label} 时浏览器上下文被关闭，正在重启后重试一次`);
      await context.close().catch(() => {});
      setContext(null);
    }
  }
  throw lastError;
}

// ===== 截图 =====
const screenshotsEnabled = config.runtime.screenshots !== false && !args.has('--no-screenshots');
const screenshotDir = path.join(runtimeDir, 'screenshots', new Date().toISOString().slice(0, 10));

function safeShotName(text) {
  return String(text || '').replace(/[^\w一-龥-]+/g, '_').slice(0, 60) || 'shot';
}

// 截当前页面视口，存 .runtime/screenshots/<日期>/，失败不阻塞采集
async function capturePage(page, label) {
  if (!screenshotsEnabled) return '';
  try {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const file = path.join(screenshotDir, `${safeShotName(label)}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 15000 });
    return file;
  } catch (error) {
    console.log(`[截图] ${label} 截图失败(不影响采集)：${String(error.message).split('\n')[0]}`);
    return '';
  }
}

// 逐条评论元素截图：实现在 shot-utils.mjs(与 backfill-shots.mjs 共用)。
// 按评论内容文本定位该条评论的 DOM 容器(含作者名/时间/子回复)，元素级截图挂热门评论表，
// 和「评论内容」一一对应；作者名核不上就放弃(宁缺勿错)
async function captureCommentShot(page, video, comment) {
  if (!screenshotsEnabled) return '';
  return await captureCommentShotUtil(page, {
    platform: video.platform || 'xiaohongshu',
    noteId: video.noteId,
    content: cleanText(comment.title || comment.content, 200),
    author: cleanText(comment.author, 30),
    outDir: screenshotDir
  });
}

function cell(record, name) {
  return record?.fields?.[name] ?? record?.[name] ?? null;
}

function normalizeNoteIdXhs(note) {
  if (note.noteId) return String(note.noteId);
  const url = note.url || note.shareUrl || '';
  const match = url.match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : '';
}

function normalizeVideoUrlXhs(note) {
  const raw = note.shareUrl || note.url || '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/);
    if (match) return `https://www.xiaohongshu.com/discovery/item/${match[1]}${url.search || ''}`;
    return url.toString();
  } catch {
    return raw;
  }
}

function isVideoNoteXhs(note) {
  const type = String(note.noteType || '');
  const media = String(note.mediaUrls || '');
  return type.includes('视频') || /video|\.mp4|sns-video/i.test(media);
}

// 判定内容年份：抖音 aweme_id 是 snowflake(>>32 为秒级时间戳)，其它平台用 publishTime；判不出返回空(调用方保留)
function videoYear(note) {
  if (note.platform === 'douyin' && /^\d{15,25}$/.test(String(note.videoId || ''))) {
    try {
      const ts = Number(BigInt(note.videoId) >> 32n) * 1000;
      const y = new Date(ts).getFullYear();
      if (y > 2015 && y < 2100) return String(y);
    } catch {}
  }
  const m = String(note.publishTime || '').match(/(20\d{2})/);
  return m ? m[1] : '';
}

function numberValue(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).replace(/,/g, '').trim();
  const num = parseFloat(text);
  if (Number.isNaN(num)) return 0;
  if (text.includes('亿')) return Math.round(num * 100000000);
  if (/万|[wW]/.test(text)) return Math.round(num * 10000); // 抖音用 w 表示万(1.2w=12000)，别漏
  if (/[千kK]/.test(text)) return Math.round(num * 1000);
  return Math.round(num);
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(range, fallback) {
  if (fastTest) return 1000;
  const source = Array.isArray(range) && range.length === 2 ? range : fallback;
  const min = Number(source[0]) || 0;
  const max = Number(source[1]) || min;
  return Math.max(0, Math.round(min + Math.random() * Math.max(0, max - min)));
}

async function humanDelay(label, range, fallback) {
  const ms = randomDelayMs(range, fallback);
  if (ms <= 0) return;
  const seconds = Math.round(ms / 1000);
  console.log(`[节奏控制] ${label}，等待 ${seconds} 秒`);
  await sleep(ms);
}

// 页面渲染停顿：fast-test + --settle-ms 时用固定时长(给 B站 shadow DOM/抖音懒加载留渲染时间)，否则走正常随机停顿
async function pageSettle(label, range, fallback) {
  if (fastTest && fastSettleMs > 0) {
    console.log(`[节奏控制] ${label}，等待 ${Math.round(fastSettleMs / 1000)} 秒`);
    await sleep(fastSettleMs);
    return;
  }
  await humanDelay(label, range, fallback);
}

function makeTopic(comment) {
  const text = cleanText(comment, 80);
  if (!text) return '';
  if (/[？?]$/.test(text)) return text.replace(/\?$/, '？');
  if (/怎么|如何|为什么|能不能|有没有|哪里|求|请问/.test(text)) return `${text.replace(/[。.!！]+$/g, '')}？`;
  return `如何解决「${text.replace(/[。.!！]+$/g, '')}」这个问题？`;
}

async function waitForLogin(page, platformName = 'xiaohongshu') {
  const p = PLATFORM[platformName] || PLATFORM.xiaohongshu;
  await gotoWithRetry(page, p.home, '登录态检查页'); // 启动首个 goto 偶发 ERR_ABORTED，带退避重试
  await humanDelay('登录态检查页面停顿', delays.loginCheckSettleMs, [12000, 20000]);
  return loginStateFromPage(page, p);
}

// 登录态判定：有 loginCookie 的平台(抖音/B站)以登录 cookie 为权威(最可靠，登出态首页常无登录文案)，否则用文案墙兜底(小红书)
async function loginStateFromPage(page, p) {
  const adapter = p && p.loginCheckWall ? p : PLATFORM.xiaohongshu;
  let cookieLoggedIn = null;
  if (adapter.loginCookie) {
    try {
      const cookies = await page.context().cookies();
      cookieLoggedIn = cookies.some((c) => adapter.loginCookie.test(c.name) && c.value && c.value.length > 6);
    } catch {
      cookieLoggedIn = null;
    }
  }
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  let loggedOut;
  if (cookieLoggedIn !== null) {
    loggedOut = !cookieLoggedIn;
  } else if (!text || text.trim().length < 30) {
    loggedOut = true; // 无 cookie 判据的平台(小红书)页面没渲染出来时保守判未登录，别 fail-open 假定已登录
  } else {
    loggedOut = adapter.loginCheckWall.test(text);
  }
  return { loggedOut, cookieLoggedIn, text: cleanText(text, 300), url: page.url() };
}

async function waitForLoginSetup(page, platformName) {
  const p = PLATFORM[platformName] || PLATFORM.xiaohongshu;
  const timeoutMs = Number(process.env.XHS_LOGIN_SETUP_TIMEOUT_MS || 10 * 60 * 1000);
  const pollMs = 5000;
  await page.goto(p.home, {
    waitUntil: 'domcontentloaded',
    timeout: config.runtime.navigationTimeoutMs
  });
  console.log(`[登录初始化] 请在打开的专用 Chrome 窗口完成 ${p.label} 扫码或手机号登录。profileDir=${profileDir}`);
  console.log('[登录初始化] 脚本会持续检测，确认已登录后才会退出。');

  const startedAt = Date.now();
  let lastLoggedOutText = '';
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    const state = await loginStateFromPage(page, p);
    if (!state.loggedOut) {
      await sleep(3000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: config.runtime.navigationTimeoutMs }).catch(() => {});
      await sleep(3000);
      const verifiedState = await loginStateFromPage(page, p);
      if (!verifiedState.loggedOut) return verifiedState;
    }
    const text = cleanText(state.text, 120);
    if (text && text !== lastLoggedOutText) {
      console.log(`[登录初始化] 当前仍未登录：${text}`);
      lastLoggedOutText = text;
    }
  }

  throw new Error(`${p.label}登录初始化超时。请确认扫码后已经在手机端点确认，并且登录发生在专用 Chrome 窗口。profileDir=${profileDir}`);
}

async function runMeixunScript(page, script, message, timeoutMs) {
  return await page.evaluate(async ({ script, message, timeoutMs }) => {
    window.__mxMessages = [];
    window.__mxListeners = [];
    const runtimeShim = {
      sendMessage: (msg) => {
        window.__mxMessages.push(msg);
        return Promise.resolve({ success: true });
      },
      onMessage: {
        addListener: (fn) => {
          window.__mxListeners.push(fn);
        }
      },
      // 抖音脚本会调 chrome.runtime.getURL 加载播放地址脚本；shim 返回路径字符串避免抛错，该步失败只丢 videoUrl 不影响核心字段
      getURL: (resourcePath) => String(resourcePath || ''),
      id: 'meixun-playwright-shim'
    };
    const existingChrome = window.chrome;
    if (existingChrome && typeof existingChrome === 'object') {
      existingChrome.runtime = {
        ...(existingChrome.runtime && typeof existingChrome.runtime === 'object' ? existingChrome.runtime : {}),
        ...runtimeShim
      };
    } else {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: runtimeShim },
        configurable: true
      });
    }
    try {
      (0, eval)(script);
    } catch (error) {
      return { ok: false, error: String(error), messages: window.__mxMessages };
    }
    const listener = window.__mxListeners[0];
    if (!listener) return { ok: false, error: '媒讯助手采集脚本没有注册消息监听', messages: window.__mxMessages };
    const response = await new Promise((resolve) => {
      try {
        listener(message, {}, (value) => resolve(value));
      } catch (error) {
        resolve({ ok: false, error: String(error) });
      }
      setTimeout(() => resolve({ timeout: true }), 5000);
    });
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const completed = window.__mxMessages.some((msg) => {
        if (!msg || typeof msg !== 'object') return false;
        if (msg.type === 'COLLECTION_ERROR') return true;
        if (msg.type === 'COLLECTION_COMPLETED') return true;
        if (msg.type === 'COLLECTION_DONE') return true;
        return false;
      });
      if (completed) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { ok: true, response, messages: window.__mxMessages };
  }, { script, message, timeoutMs });
}

function extractRecords(result) {
  const records = [];
  for (const msg of result.messages || []) {
    if (Array.isArray(msg?.records)) records.push(...msg.records);
    if (Array.isArray(msg?.data?.records)) records.push(...msg.data.records);
  }
  const seen = new Set();
  return records.filter((record) => {
    const key = record.id || record.url || `${record.title || ''}-${record.author || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTransientNavError(error) {
  const text = String(error?.message || error || '');
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_NAME_NOT_RESOLVED|ERR_ABORTED|Timeout.*exceeded/i.test(text);
}

async function gotoWithRetry(page, url, label) {
  const backoffs = [1500, 4000, 9000];
  let lastError = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.runtime.navigationTimeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt >= backoffs.length || !isTransientNavError(error)) throw error;
      const wait = backoffs[attempt];
      console.log(`[网络重试] ${label} 打开失败(${String(error.message).split('\n')[0]})，${Math.round(wait / 1000)} 秒后重试 ${attempt + 1}/${backoffs.length}`);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function scrapeCreatorNotesOnce(context, creator, url) {
  const p = platformOf(creator);
  const scripts = scriptsOf(creator.platform);
  const page = await context.newPage();
  try {
    await gotoWithRetry(page, url, `${creator.name} 主页`);
    await pageSettle(`${creator.name} 主页加载后停顿`, delays.profilePageSettleMs, [25000, 45000]);
    const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
    // 抖音等强制登录平台：登出态首页不一定有登录文案，改用登录 cookie 权威判定，缺失即抛明确错(否则静默空跑)
    if (p.loginCookie && p.loginRequired) {
      const cks = await page.context().cookies().catch(() => []);
      const hasLogin = cks.some((c) => p.loginCookie.test(c.name) && c.value && c.value.length > 6);
      if (!hasLogin) {
        throw new Error(`${p.label}当前未登录（缺少有效登录 cookie），请 ./run.sh --login-setup --platform=${creator.platform} 重新登录`);
      }
    }
    if (p.profileLoginWall.test(text)) {
      throw new Error(`${p.label}当前未登录，页面提示需要登录后查看内容`);
    }
    // 主页截图(主页/空间页)，路径挂 creator，主循环里按存储后端回传(缺图才补)
    creator._profileShot = await capturePage(page, `${creator.platform || 'xiaohongshu'}-${creator.name}-主页`);
    // 内置 DOM 采集器：没配增强脚本的平台走这里(默认)；抖音增强脚本已随改版失效，恒走内置
    if (!scripts || p.customVideoList) {
      const records = await builtinVideoList(page, creator.platform || 'xiaohongshu', effectiveMaxNotes);
      console.log(`[${creator.name}] 内置采集器抓到内容列表：${records.length} 条`);
      return records;
    }
    // 增强脚本路径：回填时 maxCount 大、每条详情间隔 detailDelay，列表采集超时要随之放大(超时=拿0条)
    const listTimeout = backfill
      ? Math.max(config.runtime.collectionTimeoutMs, Math.round(effectiveMaxNotes * (Number(config.runtime.detailDelayMs) || 8000) * 1.4) + 120000)
      : config.runtime.collectionTimeoutMs;
    const result = await runMeixunScript(page, scripts.userVideo, {
      type: p.collectVideosType,
      maxCount: effectiveMaxNotes,
      fetchDetail: p.fetchDetail(),
      detailDelay: Number(config.runtime.detailDelayMs) || 8000,
      ...p.extraVideoPayload,
      taskInfo: {
        ...p.videoTaskInfo,
        links: [creator.profileUrl]
      }
    }, listTimeout);
    const error = result.messages?.find((msg) => msg?.type === 'COLLECTION_ERROR');
    if (error) throw new Error(error.error || `${p.label}内容列表采集失败`);
    return extractRecords(result);
  } finally {
    await page.close().catch(() => {});
  }
}

async function collectCreatorNotes(context, creator) {
  const primary = creator.resolvedUrl || creator.profileUrl;
  let records = await scrapeCreatorNotesOnce(context, creator, primary);
  // resolvedUrl 的 xsec_token 会过期；采到 0 条时回退裸链 profileUrl 再试一次
  if (records.length === 0 && creator.resolvedUrl && creator.profileUrl && creator.profileUrl !== creator.resolvedUrl) {
    console.log(`[${creator.name}] resolvedUrl 采到 0 条，回退裸链 profileUrl 重试`);
    records = await scrapeCreatorNotesOnce(context, creator, creator.profileUrl);
  }
  return records;
}

// selectTopItems(records)：由调用方注入的「排序取 topN + 去重」逻辑，返回将要入库的评论项；
// 趁评论页还开着，给每个入库项做元素级评论截图(item.shotComment)，页面一关 DOM 就没了
async function collectNoteComments(context, video, selectTopItems) {
  const p = PLATFORM[video.platform] || PLATFORM.xiaohongshu;
  const scripts = scriptsOf(video.platform);
  const isXhs = (video.platform || 'xiaohongshu') === 'xiaohongshu';
  const page = await context.newPage();
  try {
    // 小红书内置采集器：详情裸链无 xsec_token 会被拦，改回主页点卡片让 XHS 带 token 打开；增强脚本路径仍直接 goto
    if (isXhs && !scripts && video.profileUrl) {
      const opened = await openXhsNoteViaProfile(page, video.profileUrl, video.noteId);
      if (!opened) throw new Error('小红书笔记打开失败（xsec_token 拦截或卡片已下架），跳过该笔记');
      await pageSettle('评论页加载后停顿', delays.notePageSettleMs, [25000, 45000]);
    } else {
      await gotoWithRetry(page, video.url, '评论页');
      await pageSettle('评论页加载后停顿', delays.notePageSettleMs, [25000, 45000]);
    }
    const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
    if (p.loginWall.test(text)) {
      throw new Error(`${p.label}当前未登录，无法查看评论`);
    }
    // 内容截图：详情页刚加载完、还在页面顶部，正是笔记/视频内容本体，挂「内容截图」列
    video.shotContent = await capturePage(page, `${video.platform || 'xhs'}-${video.noteId || 'video'}-内容`);
    // 抖音列表卡片不带标题，从视频详情页补一下描述当标题
    if (!video.title) {
      const vt = await page.evaluate(() => {
        const d = document.querySelector('[data-e2e="video-desc"], h1, [class*="video-info"] [class*="title"]');
        return ((d && d.innerText) || document.title || '').replace(/\s+/g, ' ').trim();
      }).catch(() => '');
      if (vt) video.title = vt.replace(/\s*[-|_]\s*(抖音|哔哩哔哩|bilibili).*$/i, '').slice(0, 200);
    }
    let records;
    if (!scripts) {
      // 内置 DOM 采集器(默认)：滚动评论区逐容器解析 作者/内容/时间/点赞
      records = await builtinComments(page, video.platform || 'xiaohongshu', config.runtime.maxCommentsPerVideo);
      console.log(`[内置采集器] 评论抓到 ${records.length} 条`);
    } else {
      const result = await runMeixunScript(page, scripts.comment, {
        type: p.commentType,
        maxCount: config.runtime.maxCommentsPerVideo,
        ...p.extraCommentPayload,
        taskInfo: {
          ...p.commentTaskInfo,
          links: [video.url]
        }
      }, config.runtime.commentTimeoutMs);
      const error = result.messages?.find((msg) => msg?.type === 'COLLECTION_ERROR');
      if (error) throw new Error(error.error || `${p.label}评论采集失败`);
      records = extractRecords(result);
      // 小红书增强脚本失败走 COLLECTION_DONE{count:0,error} 而非 COLLECTION_ERROR，别静默吞成 0 条
      if (p.commentFailViaDone) {
        const doneErr = result.messages?.find((msg) => msg?.type === 'COLLECTION_DONE' && msg?.error);
        if (doneErr && records.length === 0) {
          throw new Error(String(doneErr.error) || '笔记评论采集失败');
        }
        if (doneErr) {
          console.log(`[采集告警] 评论采集报错但已拿到 ${records.length} 条：${String(doneErr.error).split('\n')[0]}`);
        }
      }
    }
    const items = selectTopItems ? selectTopItems(records) : [];
    let shotCount = 0;
    for (const item of items) {
      item.shotComment = await captureCommentShot(page, video, item.comment);
      if (item.shotComment) shotCount += 1;
    }
    if (items.length > 0) {
      console.log(`[截图] 评论元素截图 ${shotCount}/${items.length} 条`);
    }
    return { records, items };
  } finally {
    await page.close().catch(() => {});
  }
}

function sortTopComments(comments) {
  return comments
    .filter((comment) => cleanText(comment.title || comment.content))
    .sort((a, b) => {
      const likeDelta = numberValue(b.likes) - numberValue(a.likes);
      if (likeDelta) return likeDelta;
      const replyDelta = numberValue(b.extra?.replyCount) - numberValue(a.extra?.replyCount);
      if (replyDelta) return replyDelta;
      return String(b.publishTime || '').localeCompare(String(a.publishTime || ''));
    })
    .slice(0, config.runtime.topCommentsPerVideo);
}

function videoRows(videos) {
  const fields = ['平台', '标题', '博主', '视频链接', '笔记 ID', '发布时间', '点赞数', '收藏数', '评论数', '正文', '标签', '封面', '媒体地址', '首次发现时间', '运行批次', '唯一键'];
  const rows = videos.map((video) => {
    const plat = video.platform || 'xiaohongshu';
    // 采集不到的互动数一律保留 null，不伪造成真实 0(采集器已把抓不到的置 null)：
    // 抖音直抓列表拿不到赞/藏/评论数；B站列表卡片给的是弹幕数非评论数，也置 null
    const num = (v) => (v == null ? null : numberValue(v));
    return [
      (PLATFORM[plat] || PLATFORM.xiaohongshu).label,
      cleanText(video.title, 200) || '无标题',
      video.creatorName,
      video.url,
      video.noteId,
      video.publishTime || null,
      num(video.likes),
      num(video.collects),
      num(video.comments),
      cleanText(video.content, 2000),
      cleanText(video.tags, 500),
      video.coverUrl || '',
      cleanText(video.mediaUrls, 2000),
      now(),
      runId,
      video.uniqueKey
    ];
  });
  return { fields, rows };
}

function commentRows(commentItems) {
  const fields = ['平台', '评论内容', '博主', '视频标题', '视频链接', '笔记 ID', '评论 ID', '评论作者', '评论时间', '评论点赞数', '回复数', '排名', '可转化选题', '素材状态', '入库日期', '唯一键'];
  const rows = commentItems.map((item) => [
    (PLATFORM[item.video.platform] || PLATFORM.xiaohongshu).label,
    cleanText(item.comment.title || item.comment.content, 1000),
    item.video.creatorName,
    cleanText(item.video.title, 200),
    item.video.url,
    item.video.noteId,
    item.comment.id || item.comment.commentId || '',
    item.comment.author || '',
    item.comment.publishTime || '',
    numberValue(item.comment.likes),
    numberValue(item.comment.extra?.replyCount),
    item.rank,
    makeTopic(item.comment.title || item.comment.content),
    '待处理',
    now(),
    item.uniqueKey
  ]);
  return { fields, rows };
}

function logRows(status, stats, failureReason) {
  return {
    fields: ['运行批次', '运行日期', '状态', '扫描博主数', '新视频数', '抓取评论数', '入库评论数', '失败原因'],
    rows: [[
      runId,
      now(),
      status,
      stats.scannedCreators,
      stats.insertedVideos ?? stats.newVideos,
      stats.fetchedComments,
      stats.insertedComments,
      failureReason || ''
    ]]
  };
}

function flushCreatorData(creatorName, creatorVideos, creatorComments, stats, errors) {
  let commentOk = 0;
  let videoOk = 0;
  // 评论是核心产物，先写、独立 try，不被视频写库失败连坐。
  // 截图按行序随数据交给存储层：feishu 挂附件字段，local 作为路径列写进行里，一一对应关系两边一致
  if (creatorComments.length > 0) {
    try {
      const cp = commentRows(creatorComments);
      const commentShots = creatorComments.map((item) => item.shotComment || '');
      commentOk = storage.saveComments(cp, commentShots).written;
      stats.insertedComments += commentOk;
    } catch (error) {
      errors.push(`${creatorName} 评论入库失败: ${error.message}`);
    }
  }
  if (creatorVideos.length > 0) {
    try {
      const vp = videoRows(creatorVideos);
      const videoShots = creatorVideos.map((video) => video.shotContent || '');
      videoOk = storage.saveVideos(vp, videoShots).written;
      stats.insertedVideos += videoOk;
    } catch (error) {
      errors.push(`${creatorName} 视频入库失败: ${error.message}`);
    }
  }
  if (creatorVideos.length > 0 || creatorComments.length > 0) {
    console.log(`[${creatorName}] 已入库：视频 ${videoOk}/${creatorVideos.length}，评论 ${commentOk}/${creatorComments.length}`);
  }
}

async function main() {
  acquireRunLock();
  let context = null;
  try {
    const creators = config.creators
      .filter((creator) => creator.enabled !== false)
      .filter((creator) => !onlyPlatform || (creator.platform || 'xiaohongshu') === onlyPlatform)
      .filter((creator) => !creatorMatch || (creator.name || '').includes(creatorMatch));
    const targetCreators = limitCreators > 0 ? creators.slice(0, limitCreators) : creators;

    // 存储后端初始化：local(默认，零依赖) / feishu(绑定后完全体)。
    // 登录操作(--login-setup/--login-check)用不到去重集，跳过全量读库(feishu 逐页翻表分钟级)，
    // 不然登录窗口要白等几分钟才弹出来，用户会误判失败去重复点
    storage = createStorage(config, { runtimeDir, dryRun, projectDir: __dirname });
    console.log(`[存储] ${storage.describe()}`);
    const loginOnly = loginSetup || loginCheck;
    const existingVideoKeys = loginOnly ? new Set() : storage.loadVideoKeys();
    const existingCommentKeys = loginOnly ? new Set() : storage.loadCommentKeys();

    // 博主主页截图：启动时读一次存量，只给还没有图的博主补(一博主一张，避免越挂越多)
    const creatorShotKey = (creator) => `${platformOf(creator).label}|${creator.name}`;
    const creatorShotTargets = (!loginOnly && screenshotsEnabled)
      ? storage.loadCreatorShotTargets(targetCreators, creatorShotKey)
      : new Map();

    if (closeExistingProfile) {
      closeExistingProfileProcesses();
      clearStaleSingletonLocks(); // 删锁安全前提=无活进程占用 profile，由关进程建立，必须捆绑；--no-close-profile 时不删
    }

    context = await launchContextWithRetry();

    const stats = { scannedCreators: 0, newVideos: 0, fetchedComments: 0, insertedComments: 0, insertedVideos: 0 };
    const errors = [];
    let failedCreators = 0;
    let remainingVideoBudget = backfill ? Infinity : (Number(config.runtime.maxVideosPerRun || 0) || Infinity);
    if (limitNew > 0) remainingVideoBudget = Math.min(remainingVideoBudget, limitNew); // --limit-new 小步验证：入库 N 条就收工

    context = await ensureContext(context);
    const loginPage = await context.newPage();
    if (loginSetup) {
      const loginState = await waitForLoginSetup(loginPage, loginPlatform);
      writeLoginStatus(loginPlatform, !loginState.loggedOut);
      console.log(JSON.stringify({
        platform: loginPlatform,
        loginState,
        profileDir,
        next: '登录态已保存。可运行 ./run.sh --login-check 复核，然后 ./run.sh 正式采集。'
      }, null, 2));
      return;
    }
    // --login-check：按用户 --platform 指定的平台查登录态，打印后返回
    if (loginCheck) {
      const loginState = await waitForLogin(loginPage, loginPlatform);
      await loginPage.close().catch(() => {});
      writeLoginStatus(loginPlatform, !loginState.loggedOut);
      console.log(JSON.stringify({ loginState, profileDir, storage: storage.describe() }, null, 2));
      return;
    }
    // 正式采集：小红书靠页面文案判登录，抖音/B站靠 per-creator cookie 检查(在 scrapeCreatorNotesOnce 里)。
    // 登录预检只在有小红书博主时做，否则纯 B站/抖音的 L0 下载即用无需依赖小红书可达(打不开小红书不该连累整轮)
    const hasXhsCreator = targetCreators.some((c) => (c.platform || 'xiaohongshu') === 'xiaohongshu');
    if (hasXhsCreator) {
      let loginState;
      try {
        loginState = await waitForLogin(loginPage, 'xiaohongshu');
      } catch (error) {
        await loginPage.close().catch(() => {});
        throw new Error(`小红书登录预检失败(打不开小红书)：${String(error.message).split('\n')[0]}`);
      }
      await loginPage.close().catch(() => {});
      writeLoginStatus('xiaohongshu', !loginState.loggedOut);
      if (loginState.loggedOut) {
        throw new Error(`小红书未登录。请先 ./run.sh --login-setup 登录，再重新运行。profileDir=${profileDir}`);
      }
    } else {
      await loginPage.close().catch(() => {});
      console.log('[登录] 本轮无小红书博主，跳过小红书登录预检（抖音/B站在采集时各自校验 cookie）');
    }
    await humanDelay('启动后缓冲', delays.startupMs, [60000, 120000]);

    const runStartedAt = now();
    for (let creatorIndex = 0; creatorIndex < targetCreators.length; creatorIndex += 1) {
      const creator = targetCreators[creatorIndex];
      if (creatorIndex > 0) {
        // 博主间隙安全检查点：读到停止标记就优雅退出，不进入下一个博主，走 finally 正常释放锁
        if (isStopRequested()) {
          console.log('[停止] 检测到 stop-requested.json，优雅退出，不再处理后续博主');
          break;
        }
        await humanDelay('博主之间停顿', delays.betweenCreatorsMs, [300000, 600000]);
      }
      writeProgress(creatorIndex, creator.name, targetCreators.length, runStartedAt, creator.platform || 'xiaohongshu');
      stats.scannedCreators += 1;
      try {
        console.log(`[${creator.name}] 开始采集最新笔记`);
        const notes = await withContextRecovery(
          () => context,
          (value) => { context = value; },
          `${creator.name} 主页采集`,
          (activeContext) => collectCreatorNotes(activeContext, creator)
        );
        const p = platformOf(creator);
        // 主页截图归位：交给存储层(feishu 挂博主清单表附件 / local 记 creator-shots.json)，缺图才补
        const exactKey = `${p.label}|${creator.name}`;
        const creatorKey = creatorShotTargets.has(exactKey) ? exactKey
          : (creatorShotTargets.has(`|${creator.name}`) ? `|${creator.name}` : null); // 平台列空的行按名字兜底
        if (creator._profileShot && creatorKey) {
          if (storage.saveCreatorShot(creatorShotTargets.get(creatorKey), creatorKey, creator._profileShot)) {
            creatorShotTargets.delete(creatorKey);
            console.log(`[${creator.name}] 主页截图已归档（${storage.kind === 'feishu' ? '博主清单表' : '本地 creator-shots.json'}）`);
          }
        }
        const isXhs = (creator.platform || 'xiaohongshu') === 'xiaohongshu';
        const allVideoNotes = notes
          .filter((note) => p.isVideo(note))
          .map((note) => {
            const contentId = p.normalizeId(note);
            const url = p.normalizeUrl(note);
            const baseKey = contentId || url;
            return {
              ...note,
              platform: creator.platform || 'xiaohongshu',
              creatorName: creator.name,
              noteId: contentId,
              url,
              profileUrl: creator.resolvedUrl || creator.profileUrl, // 小红书内置采集器要回主页点卡片开笔记(裸链无 xsec_token 会被拦)
              uniqueKey: isXhs ? baseKey : `${creator.platform}:${baseKey}`
            };
          });
        let yearScoped = allVideoNotes;
        if (yearFilter) {
          const datable = allVideoNotes.filter((note) => videoYear(note)).length;
          // 小红书列表卡片不带发布时间(videoYear 恒空)，--year 对它无从过滤，全量保留。明确告警，别让用户误以为按年过滤已生效
          if (isXhs && datable === 0 && allVideoNotes.length > 0) {
            console.log(`[${creator.name}] ⚠️ 小红书列表无发布时间，--year=${yearFilter} 无法过滤，本博主按全量处理`);
          }
          yearScoped = allVideoNotes.filter((note) => {
            const y = videoYear(note);
            if (!y) return true; // 判不出年份就保留，避免漏掉目标年份
            return y === yearFilter;
          });
          const droppedByYear = allVideoNotes.length - yearScoped.length;
          if (droppedByYear > 0) {
            console.log(`[${creator.name}] 按年份(${yearFilter})过滤掉 ${droppedByYear} 条非目标年份内容`);
          }
        }
        const freshVideoNotes = yearScoped.filter((note) => note.uniqueKey && !existingVideoKeys.has(note.uniqueKey));
        const skippedExisting = yearScoped.length - freshVideoNotes.length;
        if (skippedExisting > 0) {
          console.log(`[${creator.name}] 跳过已入库笔记 ${skippedExisting} 条，新笔记 ${freshVideoNotes.length} 条`);
        }
        const maxNewVideosPerCreator = backfill ? freshVideoNotes.length : (Number(config.runtime.maxNewVideosPerCreator || 0) || freshVideoNotes.length);
        const selectedVideoNotes = freshVideoNotes.slice(0, Math.min(maxNewVideosPerCreator, remainingVideoBudget));

        const creatorVideos = [];
        for (const video of selectedVideoNotes) {
          existingVideoKeys.add(video.uniqueKey);
          creatorVideos.push(video);
        }
        stats.newVideos += selectedVideoNotes.length;
        remainingVideoBudget -= selectedVideoNotes.length;

        const pendingComments = [];
        // 评论采集抛错的视频：本轮不入库、下轮可重试。否则视频行照写、去重键持久化，
        // 下轮 loadVideoKeys 把它当已入库跳过，该笔记评论(核心产物)永久丢失且无补抓路径
        const failedVideoKeys = new Set();
        if (!skipComments) {
          for (const video of selectedVideoNotes) {
            const videoComments = [];
            try {
              await humanDelay('打开评论页前停顿', delays.beforeCommentMs, [90000, 180000]);
              console.log(`[${creator.name}] 抓评论：${video.title || video.noteId}`);
              // 排序取 topN + 去重的选择逻辑注入给采集函数，让它趁评论页还开着给每条入库评论做元素截图。
              // 去重键在采集成功返回后才提交进 existingCommentKeys，避免上下文崩溃重试时把本页评论误判成已入库
              const selectTopItems = (comments) => {
                const top = sortTopComments(comments);
                const items = [];
                top.forEach((comment, index) => {
                  const commentId = comment.id || comment.commentId || `${cleanText(comment.author, 20)}-${cleanText(comment.title || comment.content, 40)}`;
                  const uniqueKey = `${video.uniqueKey || video.noteId || video.url}:${commentId}`;
                  if (existingCommentKeys.has(uniqueKey)) return;
                  if (items.some((it) => it.uniqueKey === uniqueKey)) return;
                  items.push({ video, comment, rank: index + 1, uniqueKey });
                });
                return items;
              };
              const { records: comments, items } = await withContextRecovery(
                () => context,
                (value) => { context = value; },
                `${creator.name} 评论采集`,
                (activeContext) => collectNoteComments(activeContext, video, selectTopItems)
              );
              stats.fetchedComments += comments.length;
              items.forEach((item) => existingCommentKeys.add(item.uniqueKey));
              videoComments.push(...items);
              await humanDelay('视频之间停顿', delays.betweenVideosMs, [180000, 360000]);
            } catch (error) {
              errors.push(`${creator.name}/${video.noteId || video.url}: ${error.message}`);
              failedVideoKeys.add(video.uniqueKey); // 评论采集失败，本视频不入库、下轮重试
              existingVideoKeys.delete(video.uniqueKey); // 本轮内存去重集也撤回，别误跳
            }
            // 回填逐条即时入库(崩溃只丢当前一条，可断点续抓)：评论采集失败的视频跳过不写，留待下轮
            if (backfill && !failedVideoKeys.has(video.uniqueKey)) {
              flushCreatorData(creator.name, [video], videoComments, stats, errors);
            } else if (!backfill) {
              pendingComments.push(...videoComments);
            }
          }
        }

        // 非回填：本博主采完统一入库(剔除评论采集失败的视频)；回填+跳评论：只入视频
        const okVideos = creatorVideos.filter((v) => !failedVideoKeys.has(v.uniqueKey));
        if (!backfill) {
          flushCreatorData(creator.name, okVideos, pendingComments, stats, errors);
        } else if (skipComments) {
          flushCreatorData(creator.name, okVideos, [], stats, errors);
        }

        if (remainingVideoBudget <= 0) {
          console.log(`已达到本轮最大新视频处理数：${config.runtime.maxVideosPerRun}`);
          break;
        }
      } catch (error) {
        errors.push(`${creator.name}: ${error.message}`);
        failedCreators += 1;
      }
    }

    let status = '成功';
    if (stats.newVideos === 0 && errors.length === 0) status = '无新增';
    if (errors.length > 0 && failedCreators < stats.scannedCreators) status = '部分失败';
    if (errors.length > 0 && failedCreators >= stats.scannedCreators && stats.scannedCreators > 0) status = '失败';
    const logPayload = logRows(status, stats, errors.join('\n').slice(0, 5000));
    storage.saveRunLog(logPayload);

    console.log(JSON.stringify({
      runId,
      status,
      stats,
      errors,
      storage: storage.describe()
    }, null, 2));
  } finally {
    await context?.close().catch(() => {});
    releaseRunLock();
    clearProgress();
    clearStopRequested();
  }
}

main().catch((error) => {
  if (error && error.code === 'RUN_LOCK_HELD') {
    // 锁冲突(如回填长跑期间 daily 撞上)不是采集失败，不写失败日志/last-failure，安静退出
    console.error(`[跳过] ${error.message}`);
    process.exit(0);
  }
  const stats = { scannedCreators: 0, newVideos: 0, fetchedComments: 0, insertedComments: 0 };
  if (!loginCheck && !loginSetup) {
    // 本地兜底：存储后端全挂(token 过期/网络)时也要在本地留一份失败证据，避免无人值守时静默丢失
    try {
      fs.writeFileSync(
        path.join(runtimeDir, 'last-failure.json'),
        JSON.stringify({ runId, at: now(), error: error.message }, null, 2)
      );
    } catch {
    }
    try {
      if (storage) {
        const logPayload = logRows('失败', stats, error.message);
        storage.saveRunLog(logPayload);
      }
    } catch (logError) {
      console.error(`写入失败日志失败：${logError.message}`);
    }
  }
  console.error(error.message);
  process.exit(1);
});
