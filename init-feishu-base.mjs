#!/usr/bin/env node
// 一键初始化飞书多维表格：用当前 lark-cli 登录身份新建一个 Base + 四张表(热门评论/视频更新/运行日志/博主清单)
// + 全部字段，然后把 base_token 和各表 table_id 写回 config.json。之后 run.sh 就能往这个 Base 写数据。
// 用法：node init-feishu-base.mjs [--config config.json] [--name "库名"] [--folder-token FT] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const found = argv.find((a) => a.startsWith(`${name}=`));
  if (found) return found.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const configPath = path.resolve(__dirname, argValue('--config', 'config.json'));
const baseName = argValue('--name', '自媒体评论素材库');
const folderToken = argValue('--folder-token', '');
const force = argv.includes('--force');

if (!fs.existsSync(configPath)) {
  console.error(`找不到 config.json：${configPath}\n请先把 config.example.json 复制成 config.json：\n  cp "${path.join(__dirname, 'config.example.json')}" "${configPath}"`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (config.base && config.base.baseToken && !force) {
  console.error(`config 里已有 baseToken=${config.base.baseToken}。\n如果确实要重新建一个新的 Base，加 --force 再跑；否则直接用现有的即可。`);
  process.exit(1);
}

function lark(args) {
  const r = spawnSync('lark-cli', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`lark-cli ${args.join(' ')}\n${r.stderr || r.stdout}`);
  }
  const text = (r.stdout || '').trim();
  return text ? JSON.parse(text) : {};
}

// 从嵌套返回里挖出 app_token / table_id，兼容不同 lark-cli 版本的字段命名
function dig(obj, keys) {
  const seen = new Set();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const k of keys) if (cur[k] && typeof cur[k] === 'string') return cur[k];
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return '';
}

const PLATFORM_OPTS = [{ name: '小红书' }, { name: '抖音' }, { name: 'B站' }];
const COMMENT_FIELDS = [
  { name: '评论内容', type: 'text' },
  { name: '评论截图', type: 'attachment' }, // 排第二列，紧挨评论内容，点开直观
  { name: '平台', type: 'select', options: PLATFORM_OPTS },
  { name: '博主', type: 'text' },
  { name: '视频标题', type: 'text' },
  { name: '视频链接', type: 'text' },
  { name: '笔记 ID', type: 'text' },
  { name: '评论 ID', type: 'text' },
  { name: '评论作者', type: 'text' },
  { name: '评论时间', type: 'text' },
  { name: '评论点赞数', type: 'number' },
  { name: '回复数', type: 'number' },
  { name: '排名', type: 'number' },
  { name: '可转化选题', type: 'text' },
  { name: '素材状态', type: 'text' },
  { name: '入库日期', type: 'text' },
  { name: '唯一键', type: 'text' }
];
const VIDEO_FIELDS = [
  { name: '标题', type: 'text' },
  { name: '内容截图', type: 'attachment' }, // 排第二列，紧挨标题；评论图在评论表、主页图在博主清单
  { name: '平台', type: 'select', options: PLATFORM_OPTS },
  { name: '博主', type: 'text' },
  { name: '视频链接', type: 'text' },
  { name: '笔记 ID', type: 'text' },
  { name: '发布时间', type: 'text' },
  { name: '点赞数', type: 'number' },
  { name: '收藏数', type: 'number' },
  { name: '评论数', type: 'number' },
  { name: '正文', type: 'text' },
  { name: '标签', type: 'text' },
  { name: '封面', type: 'text' },
  { name: '媒体地址', type: 'text' },
  { name: '首次发现时间', type: 'text' },
  { name: '运行批次', type: 'text' },
  { name: '唯一键', type: 'text' }
];
const LOG_FIELDS = [
  { name: '运行批次', type: 'text' },
  { name: '运行日期', type: 'text' },
  { name: '状态', type: 'text' },
  { name: '扫描博主数', type: 'number' },
  { name: '新视频数', type: 'number' },
  { name: '抓取评论数', type: 'number' },
  { name: '入库评论数', type: 'number' },
  { name: '失败原因', type: 'text' }
];
const CREATOR_FIELDS = [
  { name: '博主名', type: 'text' },
  { name: '主页截图', type: 'attachment' }, // 排第二列；一博主一张，缺图时采集自动补
  { name: '平台', type: 'select', options: PLATFORM_OPTS },
  { name: 'profileId', type: 'text' },
  { name: '主页链接', type: 'text' },
  { name: '备注', type: 'text' }
];

function createTable(baseToken, name, fields) {
  const res = lark([
    'base', '+table-create', '--as', 'user',
    '--base-token', baseToken, '--name', name,
    '--fields', JSON.stringify(fields), '--format', 'json'
  ]);
  const tableId = (res.data && res.data.table && res.data.table.id) || dig(res, ['table_id', 'tableId']);
  if (!tableId) throw new Error(`建表「${name}」没拿到 table_id：${JSON.stringify(res).slice(0, 400)}`);
  console.log(`  ✅ 建表「${name}」 table_id=${tableId}`);
  return tableId;
}

try {
  console.log(`[1/3] 新建多维表格「${baseName}」+ 首表「热门评论」…`);
  const createArgs = [
    'base', '+base-create', '--as', 'user',
    '--name', baseName, '--time-zone', 'Asia/Shanghai',
    '--table-name', '热门评论', '--fields', JSON.stringify(COMMENT_FIELDS), '--format', 'json'
  ];
  if (folderToken) createArgs.push('--folder-token', folderToken);
  const created = lark(createArgs);
  const baseToken = (created.data && created.data.app && created.data.app.app_token) || dig(created, ['app_token', 'appToken', 'base_token', 'baseToken']);
  const commentsTableId = (created.data && created.data.table && created.data.table.id) || (created.data && created.data.default_table_id) || '';
  if (!baseToken) throw new Error(`没拿到 base_token：${JSON.stringify(created).slice(0, 500)}`);
  console.log(`  ✅ Base app_token=${baseToken}`);
  if (commentsTableId) console.log(`  ✅ 热门评论表 table_id=${commentsTableId}`);

  console.log(`[2/3] 再建 视频更新 / 运行日志 / 博主清单 三张表…`);
  const videosTableId = createTable(baseToken, '视频更新', VIDEO_FIELDS);
  const logsTableId = createTable(baseToken, '运行日志', LOG_FIELDS);
  const creatorsTableId = createTable(baseToken, '博主清单', CREATOR_FIELDS);

  // 热门评论表 id 如果 base-create 没回，兜底再查一次表列表
  let commentsId = commentsTableId;
  if (!commentsId) {
    const list = lark(['base', '+table-list', '--as', 'user', '--base-token', baseToken, '--format', 'json']);
    const tables = (list.data && (list.data.items || list.data.data)) || [];
    const hit = Array.isArray(tables) ? tables.find((t) => (t.name || t[0]) === '热门评论') : null;
    commentsId = hit ? (hit.table_id || hit.tableId || hit[1] || '') : '';
  }

  console.log(`[3/3] 写回 config…`);
  config.storage = { ...(config.storage || {}), mode: 'feishu' }; // 建完库自动切到飞书模式(完全体)
  config.base = config.base || {};
  config.base.baseToken = baseToken;
  config.base.url = `https://feishu.cn/base/${baseToken}`;
  config.base.tables = {
    creators: creatorsTableId,
    videos: videosTableId,
    comments: commentsId,
    logs: logsTableId
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log('\n========================================');
  console.log('✅ 飞书多维表格初始化完成，存储模式已切换为 feishu');
  console.log(`   Base 链接：${config.base.url}`);
  console.log(`   已写回：${configPath}`);
  console.log('   下一步：编辑 config.json 的 creators 填上你要监控的博主，再 --login-setup 登录各平台。');
  console.log('========================================');
} catch (error) {
  console.error(`\n❌ 初始化失败：${error.message}`);
  console.error('排查：①lark-cli 是否已登录且对目标空间有建表权限(lark-cli auth status)；②飞书应用是否有 base:app:create / base:table:create scope。');
  process.exit(1);
}
