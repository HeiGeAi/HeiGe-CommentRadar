#!/usr/bin/env node
// 存量记录补截图 v2.1（截图归位 + 定位稳定性修复版）：
//   1. 博主清单表：缺「主页截图」的博主，打开主页截一张挂上（一博主一张）
//   2. 热门评论表：缺「评论截图」的评论，打开所属笔记页，按评论内容定位该条评论的 DOM 容器
//      （含作者名/时间/子回复），元素级截图挂上，和「评论内容」一一对应
//   3. 视频更新表：缺「内容截图」的记录，顺路（同一次打开笔记页）截页面顶部内容图挂上；
//      同笔记的重复行（去重失效时代遗留）每条缺图行都挂，一轮收敛
// 守卫：命中登录墙整轮停（先 --login-setup）；导航失败/内容失效页不截不传，坏图不占附件位。
// 与 run-monitor 共用 run.lock.json 双向互斥，不会互相抢 Chrome profile。
// 用法：node backfill-shots.mjs [--creator-match=某博主] [--limit-notes=20] [--skip-creators] [--dry-run]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { captureCommentShot, scrollCommentArea, pageGuard, ensureCommentsVisible, expandReplies } from './shot-utils.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const argValue = (name, fallback = null) => {
  const found = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : fallback;
};
const creatorMatch = argValue('--creator-match', '');
const limitNotes = Number(argValue('--limit-notes', '0')) || 0;
const skipCreators = process.argv.includes('--skip-creators');
const dryRun = process.argv.includes('--dry-run');

// 本脚本只服务飞书模式：local 模式下截图在采集时就作为路径列写进数据行，天然一一对应，无需补挂
const storageMode = config.storage?.mode || (config.base?.baseToken ? 'feishu' : 'local');
if (storageMode !== 'feishu') {
  console.log('当前是本地存储模式(local)，截图已直接写进数据行，无需补挂。');
  console.log('绑定飞书后(node init-feishu-base.mjs)，本脚本用于给飞书表里的存量记录补截图附件。');
  process.exit(0);
}

const profileDir = path.resolve(__dirname, config.runtime.profileDir);
const shotDir = path.join(__dirname, '.runtime', 'screenshots', new Date().toISOString().slice(0, 10));
fs.mkdirSync(shotDir, { recursive: true });

const BASE = config.base.baseToken;
const T = config.base.tables; // creators / videos / comments
const PLATFORM_SLUG = { '小红书': 'xiaohongshu', '抖音': 'douyin', 'B站': 'bilibili' };

function lark(argv, opts = {}) {
  const r = spawnSync('lark-cli', argv, { cwd: opts.cwd || __dirname, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`lark-cli 失败: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
  const t = r.stdout.trim();
  const jsonStart = t.indexOf('{');
  return jsonStart >= 0 ? JSON.parse(t.slice(jsonStart)) : {};
}

function listAll(tableId, fields) {
  const rows = [], rids = [];
  let offset = 0;
  while (true) {
    const argv = ['base', '+record-list', '--as', 'user', '--base-token', BASE, '--table-id', tableId,
      '--limit', '200', '--offset', String(offset), '--format', 'json'];
    for (const f of fields) argv.push('--field-id', f);
    const d = lark(argv);
    const data = d.data || {};
    rows.push(...(data.data || []));
    rids.push(...(data.record_id_list || []));
    if (!data.has_more) break;
    offset += 200;
  }
  return { rows, rids };
}

function upload(tableId, recordId, fieldName, filePath) {
  if (dryRun || !recordId || !filePath || !fs.existsSync(filePath)) return false;
  const r = spawnSync('lark-cli', ['base', '+record-upload-attachment', '--as', 'user', '--base-token', BASE,
    '--table-id', tableId, '--record-id', recordId, '--field-id', fieldName, '--file', path.basename(filePath)],
    { cwd: path.dirname(filePath), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) console.log(`  ↳ 上传失败(${fieldName})：${String(r.stderr || r.stdout || '').split('\n')[0]}`);
  return r.status === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const safe = (t) => String(t || '').replace(/[^\w一-龥-]+/g, '_').slice(0, 50) || 'shot';
const clean = (t, max = 200) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, max);
// 注意：字符串原型自带 .link()/.sub() 之类的坑，只有真对象才取 link/text 字段
const cellText = (v) => {
  if (Array.isArray(v)) return String(v[0] ?? '');
  if (v && typeof v === 'object') return String(v.link || v.text || '');
  return String(v ?? '');
};
const hasAttachment = (v) => Boolean(v && (!Array.isArray(v) || v.length));
// 清理 markdown 链接格式 [url](url)
const cleanUrl = (u) => { const m = String(u).match(/\((https?:[^)]+)\)/); return m ? m[1] : String(u).trim(); };

async function shotViewport(page, label) {
  try {
    const file = path.join(shotDir, `补图-${safe(label)}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 15000 });
    return file;
  } catch { return ''; }
}

// ===== 读三张表，算补图目标 =====
const creatorTable = listAll(T.creators, ['博主名', '平台', '主页截图']);
const pendingCreators = creatorTable.rows.map((r, i) => ({
  recordId: creatorTable.rids[i],
  name: cellText(r[0]),
  platform: cellText(r[1]),
  has: hasAttachment(r[2])
})).filter((c) => c.recordId && c.name && !c.has)
  .filter((c) => !creatorMatch || c.name.includes(creatorMatch));

// 分组键用 笔记 ID(同一笔记不同 xsec_token 的 URL 会分裂成多组)，没有 ID 才退回 URL。
// contentTargets 收齐该笔记全部缺图行：重复行(去重失效时代遗留)每条都要挂，否则永不收敛
const videoTable = listAll(T.videos, ['平台', '博主', '标题', '视频链接', '内容截图', '笔记 ID']);
const videosByKey = new Map();
videoTable.rows.forEach((r, i) => {
  const url = cleanUrl(cellText(r[3]));
  const key = cellText(r[5]) || url;
  if (!key || !url || !videoTable.rids[i]) return;
  const entry = videosByKey.get(key) || { url, platform: cellText(r[0]), creator: cellText(r[1]), title: cellText(r[2]), contentTargets: [] };
  entry.url = url; // 取最后见到的 URL(通常带最新 xsec_token)
  if (!hasAttachment(r[4])) entry.contentTargets.push(videoTable.rids[i]);
  videosByKey.set(key, entry);
});

const commentTable = listAll(T.comments, ['平台', '博主', '视频链接', '评论内容', '评论作者', '评论截图', '笔记 ID']);
const pendingComments = commentTable.rows.map((r, i) => ({
  recordId: commentTable.rids[i],
  platform: cellText(r[0]),
  creator: cellText(r[1]),
  url: cleanUrl(cellText(r[2])),
  noteId: cellText(r[6]),
  content: cellText(r[3]),
  author: cellText(r[4]),
  has: hasAttachment(r[5])
})).filter((c) => c.recordId && c.url && c.content && !c.has)
  .filter((c) => !creatorMatch || c.creator.includes(creatorMatch));

// 按笔记分组：一次页面访问，补齐该笔记的内容图 + 全部缺图评论
const noteGroups = new Map();
for (const c of pendingComments) {
  const key = c.noteId || c.url;
  if (!noteGroups.has(key)) noteGroups.set(key, { url: c.url, platform: c.platform, creator: c.creator, comments: [] });
  noteGroups.get(key).comments.push(c);
}
// 视频缺内容图但评论都齐的笔记，也要访问一次
for (const [key, v] of videosByKey) {
  if (v.contentTargets.length === 0 || noteGroups.has(key)) continue;
  if (creatorMatch && !v.creator.includes(creatorMatch)) continue;
  noteGroups.set(key, { url: v.url, platform: v.platform, creator: v.creator, comments: [] });
}
let noteList = [...noteGroups.entries()];
if (limitNotes > 0) noteList = noteList.slice(0, limitNotes);

console.log(`补图目标：博主主页 ${skipCreators ? 0 : pendingCreators.length} 个，笔记页 ${noteList.length} 个（缺图评论 ${pendingComments.length} 条）${creatorMatch ? `(筛:${creatorMatch})` : ''}${dryRun ? ' [dry-run]' : ''}`);
if (dryRun) {
  pendingCreators.slice(0, 15).forEach((c) => console.log(' 主页 -', c.platform, c.name));
  noteList.slice(0, 15).forEach(([key, g]) => console.log(' 笔记 -', g.platform || '(平台空)', g.creator, `评论x${g.comments.length}`, key.slice(0, 40)));
  process.exit(0);
}
if ((skipCreators || pendingCreators.length === 0) && noteList.length === 0) { console.log('没有需要补的图'); process.exit(0); }

// ===== 双向互斥锁：和 run-monitor 共用 run.lock.json，谁在跑另一个就进不来 =====
const lockPath = path.join(__dirname, '.runtime', 'run.lock.json');
function acquireLock() {
  const payload = () => JSON.stringify({ pid: process.pid, tool: 'backfill-shots', startedAt: new Date().toISOString(), argv: process.argv.slice(2) }, null, 2);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, payload(), { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let lock = null;
      try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
      if (lock && Number.isFinite(lock.pid) && lock.pid !== process.pid) {
        try {
          process.kill(lock.pid, 0);
          console.error(`已有任务在运行(pid=${lock.pid}, ${lock.tool || 'run-monitor'})，补图不能并行，等它跑完再来`);
          process.exit(1);
        } catch {}
      }
      fs.rmSync(lockPath, { force: true }); // 死锁清掉重抢
    }
  }
  console.error('抢锁两次仍失败，放弃本次补图');
  process.exit(1);
}
function releaseLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock.pid === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {}
}
acquireLock();

// 启动前复位崩溃标记，配合 --noerrdialogs 三参数，压掉「个人资料出了点问题」弹窗
try {
  const prefPath = path.join(profileDir, 'Default', 'Preferences');
  if (fs.existsSync(prefPath)) {
    const prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    if (prefs.profile) { prefs.profile.exit_type = 'Normal'; prefs.profile.exited_cleanly = true; fs.writeFileSync(prefPath, JSON.stringify(prefs)); }
  }
} catch {}

let ctx = null;
let stats = { creatorOk: 0, creatorFail: 0, contentOk: 0, commentOk: 0, commentFail: 0, skippedDead: 0 };
let fatalStop = ''; // 登录墙等全局性失败，停整轮

try {
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-proxy-server', '--noerrdialogs', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2 // 发文配图素材，2 倍物理像素保清晰度
  });

  // ===== 第一步：博主主页图 → 博主清单表 =====
  if (!skipCreators) {
    for (const [i, c] of pendingCreators.entries()) {
      if (fatalStop) break;
      const cc = (config.creators || []).find((x) => x.name === c.name && (x.platform || 'xiaohongshu') === (PLATFORM_SLUG[c.platform] || 'xiaohongshu'));
      if (!cc) { console.log(`[主页 ${i + 1}/${pendingCreators.length}] ${c.platform} ${c.name}：config 里找不到，跳过`); stats.creatorFail += 1; continue; }
      const page = await ctx.newPage();
      try {
        console.log(`[主页 ${i + 1}/${pendingCreators.length}] ${c.platform} ${c.name}`);
        // goto 失败必须抛出去走 catch：吞掉的话空白页/错误页截图会永久占住附件位
        await page.goto(cc.resolvedUrl || cc.profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(rand(9000, 14000));
        const guard = await pageGuard(page, PLATFORM_SLUG[c.platform] || 'xiaohongshu');
        if (guard.fatal) { fatalStop = guard.reason; break; }
        if (guard.skip) { console.log(`  ↳ 跳过(${guard.reason})，不上传`); stats.creatorFail += 1; continue; }
        const file = await shotViewport(page, `${c.platform}-${c.name}-主页`);
        if (file && upload(T.creators, c.recordId, '主页截图', file)) { stats.creatorOk += 1; console.log('  ↳ 已挂到博主清单'); }
        else stats.creatorFail += 1;
      } catch (e) {
        console.log(`  ↳ 失败: ${String(e.message || e).split('\n')[0]}`);
        stats.creatorFail += 1;
      } finally {
        await page.close().catch(() => {});
      }
      await sleep(rand(15000, 30000));
    }
  }

  // ===== 第二步：逐笔记页，补 内容截图(视频表，重复行每条都挂) + 逐条评论截图(评论表) =====
  for (const [i, [key, group]] of noteList.entries()) {
    if (fatalStop) break;
    const platformSlug = PLATFORM_SLUG[group.platform] || 'xiaohongshu';
    const video = videosByKey.get(key);
    const url = (video && video.url) || group.url;
    const page = await ctx.newPage();
    try {
      console.log(`[笔记 ${i + 1}/${noteList.length}] ${group.platform || '小红书'} ${group.creator} 评论x${group.comments.length} ${url.slice(0, 70)}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(rand(9000, 13000));
      const guard = await pageGuard(page, platformSlug);
      if (guard.fatal) { fatalStop = guard.reason; break; }
      if (guard.skip) {
        console.log(`  ↳ 跳过(${guard.reason})，不截不传`);
        stats.skippedDead += 1;
        stats.commentFail += group.comments.length;
        continue;
      }
      // 内容图：页面顶部就是笔记/视频本体；同笔记全部缺图行共用这一张(逐行都挂，一轮收敛)
      if (video && video.contentTargets.length > 0) {
        const file = await shotViewport(page, `${group.platform}-内容-${safe(video.title)}`);
        if (file) {
          let up = 0;
          for (const rid of video.contentTargets) {
            if (upload(T.videos, rid, '内容截图', file)) up += 1;
          }
          if (up > 0) { stats.contentOk += up; console.log(`  ↳ 内容截图已挂 ${up} 行`); }
          video.contentTargets = [];
        }
      }
      // 逐条评论：边滚边找(小红书/抖音评论在内部容器里滚，scrollCommentArea 按平台处理)，找到即截即传。
      // 连续两次确认滚不动=评论列到底了，剩下的评论页面上已经不存在(被删/被折叠)，提前收工别空转
      await ensureCommentsVisible(page, platformSlug); // 抖音右栏可能停在「相关推荐」，先把评论面板调出来
      const pending = [...group.comments];
      let noMove = 0;
      for (let step = 0; step < 14 && pending.length > 0 && noMove < 2; step += 1) {
        for (let j = pending.length - 1; j >= 0; j -= 1) {
          const c = pending[j];
          const file = await captureCommentShot(page, {
            platform: platformSlug,
            noteId: c.noteId || key,
            content: c.content,
            author: c.author,
            outDir: shotDir,
            quiet: true // 重试循环里别刷屏，最终放弃时统一打日志
          });
          if (file) {
            if (upload(T.comments, c.recordId, '评论截图', file)) { stats.commentOk += 1; console.log(`  ↳ 评论截图已挂：${clean(c.author, 20)} ${clean(c.content, 24)}`); }
            pending.splice(j, 1);
          }
        }
        if (pending.length === 0) break;
        // 目标评论可能是子回复，点开「展开N条回复」再找；点开了就重置到底计数(DOM 变了)
        const expanded = await expandReplies(page, 4);
        const moved = await scrollCommentArea(page, platformSlug, 1100);
        noMove = (moved === false && expanded === 0) ? noMove + 1 : 0;
        await sleep(rand(1500, 2600));
      }
      if (pending.length > 0) {
        stats.commentFail += pending.length;
        pending.forEach((c) => console.log(`  ↳ 评论定位失败(跳过)：${clean(c.author, 20)} ${clean(c.content, 24)}`));
      }
    } catch (e) {
      stats.commentFail += group.comments.length;
      console.log(`  ↳ 失败: ${String(e.message || e).split('\n')[0]}`);
    } finally {
      await page.close().catch(() => {});
    }
    await sleep(rand(20000, 40000)); // 温和节奏防风控
  }
} finally {
  await ctx?.close().catch(() => {});
  releaseLock();
}

if (fatalStop) {
  console.error(`\n[整轮停止] ${fatalStop}。请先 ./run.sh --login-setup --platform=<平台> 重新登录，再重跑补图（幂等，会自动续）。`);
  console.log(`已完成部分：主页 ${stats.creatorOk} 成/${stats.creatorFail} 败，内容图 ${stats.contentOk} 行，评论图 ${stats.commentOk} 成`);
  process.exit(1);
}
console.log(`\n补图完成：主页 ${stats.creatorOk} 成/${stats.creatorFail} 败，内容图 ${stats.contentOk} 行，评论图 ${stats.commentOk} 成/${stats.commentFail} 败，失效页跳过 ${stats.skippedDead}`);
