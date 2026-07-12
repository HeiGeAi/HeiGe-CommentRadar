// collectors-builtin.mjs — 内置 DOM 采集器（零第三方依赖，下载即用）。
// 直接从页面 DOM 提取博主内容列表和评论，是 CommentRadar 的默认采集方式。
// 如果你装了自己的浏览器插件类采集脚本，可在 config.collectors.meixun 里配路径切换成增强模式（可选）。
import { COMMENT_CONTAINER_SELECTORS, scrollCommentArea, expandReplies, ensureCommentsVisible } from './shot-utils.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============ 内容列表采集 ============

// 抖音：主页视频列表直抓 a[href*="/video/"]（aweme_id 是 snowflake，>>32 为秒级时间戳）
async function douyinVideoList(page, maxCount) {
  await scrollListUntil(page, () =>
    page.evaluate(() => document.querySelectorAll('a[href*="/video/"]').length).catch(() => 0), maxCount);
  return await page.evaluate((max) => {
    const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const m = (a.getAttribute('href') || a.href || '').match(/\/video\/(\d{15,25})/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const card = a.closest('li') || a.parentElement || a;
      const label = a.getAttribute('aria-label') || '';
      const descEl = card.querySelector('[class*="desc"],[class*="title"]');
      const title = (label || (descEl && descEl.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const img = card.querySelector('img');
      let publishTime = '';
      try {
        const ts = Number(BigInt(m[1]) >> 32n) * 1000;
        const dt = new Date(ts);
        if (dt.getFullYear() > 2015 && dt.getFullYear() < 2100) publishTime = dt.toISOString().slice(0, 10);
      } catch (e) {}
      out.push({
        platform: 'douyin', videoId: m[1],
        url: 'https://www.douyin.com/video/' + m[1],
        title, noteType: '视频',
        coverUrl: img ? (img.getAttribute('src') || '') : '',
        // 列表直抓拿不到互动数，置 null 不伪装成真实 0
        likes: null, collects: null, comments: null, content: '', tags: '', mediaUrls: '', publishTime
      });
      if (out.length >= max) break;
    }
    return out;
  }, maxCount);
}

// 小红书：主页笔记卡片抓 /explore|search_result|discovery 链接，href 自带 xsec_token(详情页要用，必须保留 query)
async function xiaohongshuNoteList(page, maxCount) {
  await scrollListUntil(page, () =>
    page.evaluate(() => document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="/search_result/"]').length).catch(() => 0), maxCount);
  return await page.evaluate((max) => {
    const links = Array.from(document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="/search_result/"]'));
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]{16,32})/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const card = a.closest('section') || a.closest('div[class*="note"]') || a;
      const titleEl = card.querySelector('a[class*="title"] span, [class*="title"], .footer span');
      const img = card.querySelector('img');
      const title = ((titleEl && titleEl.innerText) || (img && img.getAttribute('alt')) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const likeEl = card.querySelector('[class*="like"] [class*="count"], .count');
      const isVideoCard = Boolean(card.querySelector('[class*="play"], [class*="video"]'));
      out.push({
        platform: 'xiaohongshu', noteId: m[1],
        url: new URL(href, location.origin).toString(),
        title, noteType: isVideoCard ? '视频' : '图文',
        coverUrl: img ? (img.getAttribute('src') || '') : '',
        likes: likeEl ? likeEl.innerText.trim() : null,
        collects: null, comments: null, content: '', tags: '', mediaUrls: '', publishTime: ''
      });
      if (out.length >= max) break;
    }
    return out;
  }, maxCount);
}

// B站：空间投稿页抓 /video/BV 链接（建议 config 里直接用 space.bilibili.com/<uid>/video 投稿页）
async function bilibiliVideoList(page, maxCount) {
  await scrollListUntil(page, () =>
    page.evaluate(() => document.querySelectorAll('a[href*="/video/BV"]').length).catch(() => 0), maxCount);
  return await page.evaluate((max) => {
    const links = Array.from(document.querySelectorAll('a[href*="/video/BV"]'));
    const seen = new Set();
    const out = [];
    // 标题候选按可靠度排序，纯数字/时间/播放量这类卡片元数据一律不当标题(抓不到就留空，详情页会补)
    const pickTitle = (a, card) => {
      const candidates = [
        a.getAttribute('title'),
        card.querySelector('a[title]')?.getAttribute('title'),
        card.querySelector('[class*="tit"]')?.innerText,
        a.getAttribute('aria-label'),
        a.innerText
      ];
      for (let t of candidates) {
        t = (t || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 6 && !/^[\d\s:.\-·万亿次播放弹幕最新]+$/.test(t)) return t.slice(0, 200);
      }
      return '';
    };
    for (const a of links) {
      const m = (a.getAttribute('href') || a.href || '').match(/\/video\/(BV[0-9A-Za-z]{8,12})/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const card = a.closest('li') || a.closest('div[class*="card"]') || a.parentElement || a;
      const title = pickTitle(a, card);
      const timeEl = card.querySelector('[class*="time"], [class*="date"]');
      const img = card.querySelector('img');
      out.push({
        platform: 'bilibili', videoId: m[1],
        url: 'https://www.bilibili.com/video/' + m[1] + '/',
        title, noteType: '视频',
        coverUrl: img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '',
        likes: null, collects: null,
        comments: null, // 列表卡片给的是弹幕数不是评论数，不采免污染
        content: '', tags: '', mediaUrls: '',
        publishTime: timeEl ? timeEl.innerText.trim() : ''
      });
      if (out.length >= max) break;
    }
    return out;
  }, maxCount);
}

// 滚动加载列表：数量到目标 或 连续 3 轮不增长就停
async function scrollListUntil(page, countFn, maxCount) {
  let lastCount = 0;
  let stable = 0;
  for (let i = 0; i < 40; i += 1) {
    const count = await countFn();
    if (count >= maxCount) break;
    if (count === lastCount) {
      stable += 1;
      if (stable >= 3) break;
    } else {
      stable = 0;
    }
    lastCount = count;
    await page.evaluate(() => window.scrollBy(0, 1600)).catch(() => {});
    await sleep(1800);
  }
}

const LIST_SCRAPERS = {
  douyin: douyinVideoList,
  xiaohongshu: xiaohongshuNoteList,
  bilibili: bilibiliVideoList
};

export async function builtinVideoList(page, platform, maxCount) {
  const scraper = LIST_SCRAPERS[platform];
  if (!scraper) throw new Error(`内置采集器不支持平台：${platform}`);
  return await scraper(page, maxCount);
}

// ============ 评论采集 ============

// 通用评论解析：拿到评论容器的组合文本(跨 shadow DOM)，按行启发式拆 作者/内容/时间/点赞。
// 结构假设：首行=作者名，时间行匹配日期/相对时间模式，点赞是独立短数字行，其余为内容。
// 只解析容器里第一条(顶层评论)，时间行之后的子回复不混入。
const PARSE_CONTAINER = (node) => {
  // 跨 shadow DOM 取组合文本；STYLE/SCRIPT 里的 CSS/JS 文本必须跳过(B站自定义元素 shadow root 里带 <style>)
  const deepText = (n) => {
    if (!n) return '';
    let out = '';
    if (n.shadowRoot) out += deepText(n.shadowRoot);
    for (const child of n.childNodes || []) {
      if (child.nodeType === 3) out += child.textContent;
      else if (!/^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/i.test(child.nodeName)) { out += deepText(child); out += '\n'; }
    }
    return out;
  };
  const looksLikeCss = (l) => /[{};]/.test(l) && /:/.test(l);
  const lines = deepText(node).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).filter((l) => !looksLikeCss(l));
  if (lines.length === 0) return null;
  const isTime = (l) => /^\d{4}[-年.]\d{1,2}[-月.]\d{1,2}|^\d{1,2}[-月.]\d{1,2}(?![\d])|^(刚刚|昨天|前天|今天)|^\d+\s*(秒|分钟|小时|天|周|个月|年)前/.test(l);
  const isCount = (l) => /^\d+(\.\d+)?\s*[万wk]?$/i.test(l) || /^(赞|回复|点赞)$/.test(l);
  const author = lines[0];
  let content = [];
  let publishTime = '';
  let likes = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isTime(line)) { publishTime = line.split(' ')[0]; break; } // 时间行=顶层评论结束
    if (isCount(line)) { if (likes === null && /^\d/.test(line)) likes = line; continue; }
    if (line === author) continue;
    content.push(line);
  }
  if (likes === null) {
    // 点赞数常在时间行之后紧跟：往后再看几行
    const timeIdx = lines.findIndex((l, i) => i > 0 && isTime(l));
    if (timeIdx > 0) {
      for (const line of lines.slice(timeIdx + 1, timeIdx + 4)) {
        if (/^\d+(\.\d+)?\s*[万wk]?$/i.test(line)) { likes = line; break; }
      }
    }
  }
  const text = content.join(' ').trim();
  if (!text) return null;
  return { author, content: text.slice(0, 1000), publishTime, likes };
};

// 小红书笔记详情页必须带 xsec_token，主页卡片 href 是裸链(token 靠点击时 JS 注入)。
// 回博主主页点该笔记卡片，让 XHS 自己带 token 打开笔记，再在打开后的页面抓评论。
// 返回 true=成功打开笔记页 / false=没找到卡片或被拦
export async function openXhsNoteViaProfile(page, profileUrl, noteId) {
  if (!profileUrl || !noteId) return false;
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000);
  // 滚动找到目标笔记卡片(主页默认只加载前若干条)
  const linkSel = `a[href*="/${noteId}"]`;
  for (let i = 0; i < 15; i += 1) {
    if (await page.locator(linkSel).count().catch(() => 0) > 0) break;
    await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
    await sleep(1500);
  }
  const link = page.locator(linkSel).first();
  if (await link.count().catch(() => 0) === 0) return false;
  await link.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await sleep(600);
  // 卡片的 <a> 是零尺寸隐藏覆盖层，真正可点的是封面图；按坐标点封面中心触发 XHS 带 token 的路由
  const box = await page.evaluate((nid) => {
    const a = document.querySelector(`a[href*="/${nid}"]`);
    if (!a) return null;
    const card = a.closest('section') || a.parentElement;
    const target = (card && card.querySelector('img')) || a.querySelector('img') || card;
    if (!target) return null;
    const r = target.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, noteId);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  await sleep(3500);
  // 点开后可能是同页路由(URL 变成 /explore/{id}?xsec_token=...)或弹层，评论容器出现即算成功
  for (let i = 0; i < 8; i += 1) {
    const ready = await page.locator('.comments-el, .comment-item, .parent-comment, .note-scroller').count().catch(() => 0);
    const dead = /当前笔记暂时无法浏览|你访问的页面不见了/.test(await page.locator('body').innerText({ timeout: 3000 }).catch(() => ''));
    if (ready > 0) return true;
    if (dead) return false;
    await sleep(1500);
  }
  return false;
}

export async function builtinComments(page, platform, maxCount) {
  const selectors = COMMENT_CONTAINER_SELECTORS[platform] || COMMENT_CONTAINER_SELECTORS.xiaohongshu;
  // 抖音右栏默认可能停在「相关推荐」，评论不在 DOM 里，先点评论 tab 调出来(否则恒返回 0 条)
  await ensureCommentsVisible(page, platform).catch(() => {});
  // 滚动评论区把评论加载出来(内部容器滚动由 scrollCommentArea 按平台处理)
  let noMove = 0;
  for (let round = 0; round < 12; round += 1) {
    const count = await page.locator(selectors[0]).count().catch(() => 0);
    if (count >= maxCount) break;
    if (round >= 2) await expandReplies(page, 2).catch(() => {});
    const moved = await scrollCommentArea(page, platform, 1100);
    noMove = moved === false ? noMove + 1 : 0;
    if (noMove >= 2) break;
    await sleep(1600);
  }
  // 逐容器解析
  let containerSelector = selectors[0];
  let containers = page.locator(containerSelector);
  if ((await containers.count().catch(() => 0)) === 0 && selectors[1]) {
    containerSelector = selectors[1];
    containers = page.locator(containerSelector);
  }
  const total = Math.min(await containers.count().catch(() => 0), maxCount);
  const records = [];
  const seen = new Set();
  for (let i = 0; i < total; i += 1) {
    const handle = await containers.nth(i).elementHandle().catch(() => null);
    if (!handle) continue;
    const parsed = await handle.evaluate(PARSE_CONTAINER).catch(() => null);
    await handle.dispose().catch(() => {});
    if (!parsed) continue;
    const key = `${parsed.author}|${parsed.content.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      id: '', // DOM 拿不到评论 ID，引擎会用 作者+内容 兜底生成去重键
      title: parsed.content,
      content: parsed.content,
      author: parsed.author,
      likes: parsed.likes,
      publishTime: parsed.publishTime,
      extra: { replyCount: null, source: 'builtin' }
    });
  }
  return records;
}
