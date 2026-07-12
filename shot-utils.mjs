// shot-utils.mjs — 评论元素截图共用逻辑，run-monitor.mjs 和 backfill-shots.mjs 共同引用。
// 改这里两边同时生效，避免同构代码漂移。
import fs from 'node:fs';
import path from 'node:path';

// 平台评论容器选择器：从评论文字节点向上爬(跨 shadow DOM)找最外层匹配容器。
// 容器要包住 作者名/时间/子回复整块区域，正是发文配图要的完整评论卡片
export const COMMENT_CONTAINER_SELECTORS = {
  xiaohongshu: ['.parent-comment', '.comment-item'],
  douyin: ['[data-e2e="comment-item"]', '[class*="CommentItem"]', '[class*="comment-item"]'],
  bilibili: ['bili-comment-thread-renderer', 'bili-comment-renderer', '.reply-item']
};

// 各平台登录墙文案(取自 run-monitor 的 PLATFORM 表)：截图前的守卫，登录墙截图挂上去会永久占附件位
export const LOGIN_WALL = {
  xiaohongshu: /登录即可查看|手机号登录|获取验证码/,
  douyin: /登录后查看|扫码登录|验证码登录|立即登录|登录抖音/,
  bilibili: /请完成安全验证/
};

// 内容失效页文案：xsec_token 过期/笔记删除等，HTTP 200 但不是正文，截了也是垃圾图
export const PAGE_DEAD = /当前笔记暂时无法浏览|你访问的页面不见了|内容不存在|作品不存在|视频不见了|啊叻？视频不见了/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value, max = 200) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const safeName = (text) => String(text || '').replace(/[^\w一-龥-]+/g, '_').slice(0, 60) || 'shot';
const squash = (t) => String(t || '').replace(/\s+/g, ''); // 去全部空白再比对：表情图片会把文本切成多个 text node，空白不可信

// 把评论内容切成定位锚候选段，最长优先。两类切点：
// ①[笑哭] 这类表情占位符：页面上渲染成图片，带着它匹配必然失败
// ②句子边界(。！？换行)：贴纸文本/多行内容在采集时会被拼成一个字符串，跨 DOM 节点的
//   拼接串在页面上不存在，按句切段后单句大概率完整落在同一个文本节点里
function textSegments(content) {
  return clean(content, 200)
    .split(/\[[^\[\]]{1,12}\]|[。！？!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length);
}

// 页面健康检查：fatal=登录墙(登录态是全局的，整轮该停)；skip=本页失效(跳过该页不上传)
export async function pageGuard(page, platformSlug) {
  const text = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
  if ((LOGIN_WALL[platformSlug] || LOGIN_WALL.xiaohongshu).test(text)) {
    return { fatal: true, reason: '命中登录墙，登录态已失效' };
  }
  if (!text || text.trim().length < 30) return { skip: true, reason: '页面空白/未渲染' };
  if (PAGE_DEAD.test(text)) return { skip: true, reason: '内容已失效(笔记被删或链接过期)' };
  return {};
}

// 抖音视频页右栏可能默认停在「相关推荐」，评论根本不在 DOM 里：点评论 tab 把评论面板调出来
export async function ensureCommentsVisible(page, platformSlug) {
  if (platformSlug !== 'douyin') return;
  const count = await page.locator('[data-e2e="comment-item"]').count().catch(() => 0);
  if (count > 0) return;
  const tab = page.locator('[data-e2e*="comment-tab"], [class*="comment-tab"]').first();
  if (await tab.count().catch(() => 0)) {
    await tab.click({ timeout: 5000 }).catch(() => {});
    await sleep(2500);
    return;
  }
  const textTab = page.getByText(/^评论\s*[\d.万wk]*$/).first();
  if (await textTab.count().catch(() => 0)) {
    await textTab.click({ timeout: 5000 }).catch(() => {});
    await sleep(2500);
  }
}

// 展开子回复：目标评论可能是别人评论下的回复，藏在「展开N条回复」按钮后面不进 DOM。
// 采集时媒讯脚本会点开，补图场景要自己点。每轮最多点 maxClicks 个，返回点击数
export async function expandReplies(page, maxClicks = 6) {
  const pattern = /展开\s*\d*\s*条?回复|查看\s*\d+\s*条?回复|更多回复|条回复，点击查看/;
  let clicks = 0;
  try {
    const btns = page.getByText(pattern);
    const n = Math.min(await btns.count(), maxClicks);
    for (let i = 0; i < n; i += 1) {
      const b = btns.nth(i);
      try {
        if (await b.isVisible({ timeout: 500 })) {
          await b.click({ timeout: 3000 });
          clicks += 1;
          await sleep(900);
        }
      } catch {}
    }
  } catch {}
  return clicks;
}

// 滚动评论区加载更多：小红书/抖音评论在内部 overflow 容器里滚，window.scrollBy 无效；B站是整页滚动。
// 抖音页面 window 滚动可能切视频，非 B站平台绝不碰 window。
// 返回 true=确认滚动了 / false=确认没滚动(到底了) / null=用了滚轮兜底效果未知
export async function scrollCommentArea(page, platformSlug, px = 1100) {
  if (platformSlug === 'bilibili') {
    return await page.evaluate((d) => {
      const before = window.scrollY;
      window.scrollBy(0, d);
      return window.scrollY > before;
    }, px).catch(() => null);
  }
  const sels = COMMENT_CONTAINER_SELECTORS[platformSlug] || COMMENT_CONTAINER_SELECTORS.xiaohongshu;
  const moved = await page.evaluate((args) => {
    const { sels, d } = args;
    // 从已渲染的评论元素向上找可滚动祖先
    const probe = document.querySelector(sels.join(','));
    let cur = probe;
    while (cur) {
      if (cur.scrollHeight > cur.clientHeight + 10) {
        const before = cur.scrollTop;
        cur.scrollBy(0, d);
        if (cur.scrollTop > before) return true;
      }
      cur = cur.parentElement;
    }
    // 探针失败：全局找一个像评论列的大型可滚动容器
    for (const el of document.querySelectorAll('div')) {
      if (el.clientHeight > 300 && el.scrollHeight > el.clientHeight + 200) {
        const st = getComputedStyle(el);
        if (/(auto|scroll|overlay)/.test(st.overflowY)) {
          const before = el.scrollTop;
          el.scrollBy(0, d);
          if (el.scrollTop > before) return true;
        }
      }
    }
    return false;
  }, { sels, d: px }).catch(() => false);
  if (moved) return true;
  // 兜底：把鼠标挪到右侧评论列上方发滚轮事件，浏览器会滚它下面最近的可滚动容器
  await page.mouse.move(1150, 550).catch(() => {});
  await page.mouse.wheel(0, px).catch(() => {});
  return null;
}

// 在页面注入执行：从定位到的文字节点向上爬找评论容器，并做作者名校验(跨 shadow DOM)。
// 返回容器元素或 null。author/segment 比对都去空白：表情图片会把文本切碎，空白不可信
const CLIMB_AND_VERIFY = (el, args) => {
  const { sels, author, segment } = args;
  const squash = (t) => String(t || '').replace(/\s+/g, '');
  const deepText = (node) => {
    if (!node) return '';
    let out = '';
    if (node.shadowRoot) out += deepText(node.shadowRoot);
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) out += child.textContent;
      else if (!/^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/i.test(child.nodeName)) out += deepText(child);
    }
    return out;
  };
  let cur = el;
  let best = null;
  while (cur) {
    if (cur.nodeType === 1) {
      for (const s of sels) {
        try { if (cur.matches(s)) { best = cur; break; } } catch {}
      }
    }
    // parentElement 走普通 DOM，getRootNode().host 跨出 shadow root(B站评论区在 shadow DOM 里)
    cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
  }
  if (!best) return null;
  const text = squash(deepText(best));
  if (author && !text.includes(squash(author))) return null; // 作者核不上=可能是另一条相似评论，放弃该候选
  if (segment && !text.includes(squash(segment))) return null; // 按作者定位时反过来核内容
  return best;
};

// 逐条评论元素截图：定位该条评论的 DOM 容器(含作者名/时间/子回复)，元素级截图。
// 一一对应铁律：内容+作者双向核验，核不上宁缺勿错，不挂错人的评论。
// 两条定位通道：①最长纯文本段 getByText + 作者校验 ②作者名 getByText + 内容段校验(内容全是表情时的兜底)。
// opts.quiet=true 时不打「定位失败」日志(补图脚本的重试循环里会反复调用，只在最终放弃时由调用方打)
export async function captureCommentShot(page, { platform, noteId, content, author, outDir, quiet = false }) {
  const segments = textSegments(content);
  const needle = (segments[0] || '').slice(0, 30).trim();
  const authorClean = clean(author, 30);
  if (!needle && !authorClean) return '';
  const selectors = COMMENT_CONTAINER_SELECTORS[platform] || COMMENT_CONTAINER_SELECTORS.xiaohongshu;
  try {
    let chosen = null;
    // 通道一：按内容最长纯文本段定位，作者名校验
    if (needle && needle.length >= 4) {
      const located = page.getByText(needle, { exact: false });
      const count = Math.min(await located.count(), 8);
      for (let i = 0; i < count && !chosen; i += 1) {
        const handle = await located.nth(i).elementHandle().catch(() => null);
        if (!handle) continue;
        const container = await handle.evaluateHandle(CLIMB_AND_VERIFY, { sels: selectors, author: authorClean, segment: '' }).catch(() => null);
        await handle.dispose().catch(() => {});
        const el = container && container.asElement();
        if (!el) continue;
        // 尺寸卫兵：容器高度异常(整个评论区/折叠不可见)视为误定位，换下一个候选
        const box = await el.boundingBox().catch(() => null);
        if (!box || box.height < 40 || box.height > 3500 || box.width < 200) continue;
        chosen = el;
      }
    }
    // 通道二：内容全是表情/太短定位不了，改按作者名定位，再反核内容段(有段才允许，双向核验不放松)
    if (!chosen && authorClean && authorClean.length >= 2 && segments.length > 0) {
      const located = page.getByText(authorClean, { exact: false });
      const count = Math.min(await located.count(), 8);
      for (let i = 0; i < count && !chosen; i += 1) {
        const handle = await located.nth(i).elementHandle().catch(() => null);
        if (!handle) continue;
        const container = await handle.evaluateHandle(CLIMB_AND_VERIFY, { sels: selectors, author: '', segment: segments[0].slice(0, 30) }).catch(() => null);
        await handle.dispose().catch(() => {});
        const el = container && container.asElement();
        if (!el) continue;
        const box = await el.boundingBox().catch(() => null);
        if (!box || box.height < 40 || box.height > 3500 || box.width < 200) continue;
        chosen = el;
      }
    }
    if (!chosen) {
      if (!quiet) console.log(`[截图] 评论定位失败(跳过)：${authorClean || ''} ${(needle || clean(content, 20)).slice(0, 20)}`);
      return '';
    }
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${safeName(`${platform || 'xhs'}-${noteId || 'note'}-评论-${authorClean || needle.slice(0, 12)}`)}-${Date.now()}.png`);
    await chosen.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await sleep(500); // 滚动后给懒加载头像/图片一点渲染时间
    // 等渐显动画结束再按快门：B站评论卡片滚入视口有 opacity 过渡，截在动画中间整张图发白。
    // 沿组合树(跨 shadow root)累乘 opacity，>=0.98 或超时 2.5 秒才继续
    await chosen.evaluate(async (node) => {
      const started = Date.now();
      while (Date.now() - started < 2500) {
        let cur = node;
        let opacity = 1;
        while (cur && cur.nodeType === 1) {
          opacity *= parseFloat(getComputedStyle(cur).opacity || '1');
          cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
        }
        if (opacity >= 0.98) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }).catch(() => {});
    // 评论容器高于内部滚动容器可视区时，超出部分被 overflow 裁掉、截进无关内容：临时钳住高度只截上半段
    const containerViewH = await chosen.evaluate((node) => {
      let cur = node.parentElement;
      while (cur) {
        const st = getComputedStyle(cur);
        if (/(auto|scroll|overlay)/.test(st.overflowY) && cur.clientHeight > 100) return cur.clientHeight;
        cur = cur.parentElement;
      }
      return window.innerHeight;
    }).catch(() => 900);
    const capPx = Math.max(300, containerViewH - 40);
    const boxNow = await chosen.boundingBox().catch(() => null);
    const clamp = Boolean(boxNow && boxNow.height > capPx);
    if (clamp) {
      await chosen.evaluate((node, h) => {
        node.__shotOldMaxHeight = node.style.maxHeight;
        node.__shotOldOverflow = node.style.overflow;
        node.style.maxHeight = `${h}px`;
        node.style.overflow = 'hidden';
      }, capPx).catch(() => {});
      await sleep(200);
    }
    try {
      await chosen.screenshot({ path: file, timeout: 15000 });
    } finally {
      if (clamp) {
        await chosen.evaluate((node) => {
          node.style.maxHeight = node.__shotOldMaxHeight || '';
          node.style.overflow = node.__shotOldOverflow || '';
        }).catch(() => {});
      }
    }
    return file;
  } catch (error) {
    console.log(`[截图] 评论截图失败(不影响采集)：${String(error.message).split('\n')[0]}`);
    return '';
  }
}
