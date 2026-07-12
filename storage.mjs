// storage.mjs — 存储层双后端：local（默认，零依赖开箱即用）/ feishu（绑定飞书多维表格后的完全体）。
// 引擎只面向这里的接口写数据，不感知后端差异。
//
// local  : JSONL + CSV 双写到 .runtime/data/（CSV 带 BOM，Excel/Numbers 直接打开），
//          截图路径作为普通列写进行里，去重键从 JSONL 里读。
// feishu : lark-cli(@larksuite/cli) 写多维表格四表，截图走附件字段，去重键从表里读。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ============ 公共小工具 ============

function zipRow(fields, row) {
  const obj = {};
  fields.forEach((name, i) => { obj[name] = row[i]; });
  return obj;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function appendCsv(file, fields, rows) {
  const isNew = !fs.existsSync(file);
  let out = '';
  if (isNew) out += `﻿${fields.map(csvEscape).join(',')}\n`; // BOM 让 Excel 认 UTF-8
  for (const row of rows) out += fields.map((f) => csvEscape(row[f])).join(',') + '\n';
  fs.appendFileSync(file, out);
}

function appendJsonl(file, rows) {
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function readJsonlColumn(file, column) {
  const values = [];
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line)[column];
      if (value) values.push(String(value));
    } catch {}
  }
  return values;
}

// ============ local 后端 ============

function createLocalStorage(config, { runtimeDir, dryRun, projectDir }) {
  const dataDir = path.join(runtimeDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const F = {
    videos: path.join(dataDir, 'videos'),
    comments: path.join(dataDir, 'comments'),
    runs: path.join(dataDir, 'runs'),
    creatorShots: path.join(dataDir, 'creator-shots.json')
  };
  const rel = (p) => (p ? path.relative(projectDir, p) : '');

  const readCreatorShots = () => {
    try { return JSON.parse(fs.readFileSync(F.creatorShots, 'utf8')); } catch { return {}; }
  };

  return {
    kind: 'local',
    describe: () => `本地存储 ${path.relative(projectDir, dataDir)}/（JSONL + CSV 双写；绑定飞书可升级为多维表格，见 README）`,
    loadVideoKeys: () => new Set(readJsonlColumn(`${F.videos}.jsonl`, '唯一键')),
    loadCommentKeys: () => new Set(readJsonlColumn(`${F.comments}.jsonl`, '唯一键')),
    // 缺主页截图的博主：local 用 creator-shots.json 记「谁已经截过」，一博主一张
    loadCreatorShotTargets: (creators, keyOf) => {
      const done = readCreatorShots();
      const targets = new Map();
      for (const creator of creators) {
        const key = keyOf(creator);
        if (!done[key]) targets.set(key, key);
      }
      return targets;
    },
    saveCreatorShot: (handle, key, shotPath) => {
      if (dryRun) return true;
      const done = readCreatorShots();
      done[key] = rel(shotPath);
      fs.writeFileSync(F.creatorShots, JSON.stringify(done, null, 2));
      return true;
    },
    saveVideos: (payload, shots) => {
      if (dryRun) { console.log(`[dry-run] videos: ${payload.rows.length} rows`); return { written: payload.rows.length }; }
      const fields = [...payload.fields, '内容截图'];
      const rows = payload.rows.map((row, i) => ({ ...zipRow(payload.fields, row), 内容截图: rel(shots?.[i] || '') }));
      appendJsonl(`${F.videos}.jsonl`, rows);
      appendCsv(`${F.videos}.csv`, fields, rows);
      return { written: rows.length };
    },
    saveComments: (payload, shots) => {
      if (dryRun) { console.log(`[dry-run] comments: ${payload.rows.length} rows`); return { written: payload.rows.length }; }
      const fields = [...payload.fields, '评论截图'];
      const rows = payload.rows.map((row, i) => ({ ...zipRow(payload.fields, row), 评论截图: rel(shots?.[i] || '') }));
      appendJsonl(`${F.comments}.jsonl`, rows);
      appendCsv(`${F.comments}.csv`, fields, rows);
      return { written: rows.length };
    },
    saveRunLog: (payload) => {
      if (dryRun) return { written: 0 };
      const rows = payload.rows.map((row) => zipRow(payload.fields, row));
      appendJsonl(`${F.runs}.jsonl`, rows);
      appendCsv(`${F.runs}.csv`, payload.fields, rows);
      return { written: rows.length };
    }
  };
}

// ============ feishu 后端 ============

function createFeishuStorage(config, { runtimeDir, dryRun }) {
  const base = config.base || {};
  if (!base.baseToken || !base.tables) {
    throw new Error('storage.mode=feishu 需要 config.base.baseToken 和 config.base.tables（先跑 node init-feishu-base.mjs 一键建库）');
  }

  function runLark(argv, options = {}) {
    const result = spawnSync('lark-cli', argv, {
      cwd: options.cwd || runtimeDir,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    });
    if (result.error && result.error.code === 'ENOENT') {
      throw new Error('找不到 lark-cli。飞书模式需要先安装：npm install -g @larksuite/cli 并完成 lark-cli auth login');
    }
    if (result.status !== 0) {
      throw new Error(`lark-cli ${argv.join(' ')}\n${result.stderr || result.stdout}`);
    }
    const text = result.stdout.trim();
    return text ? JSON.parse(text) : {};
  }

  function listRecordsWithIds(tableId, fieldNames) {
    const rows = [];
    const recordIds = [];
    let offset = 0;
    while (true) {
      const argv = [
        'base', '+record-list', '--as', 'user',
        '--base-token', base.baseToken,
        '--table-id', tableId,
        '--limit', '200', '--offset', String(offset), '--format', 'json'
      ];
      for (const field of fieldNames) argv.push('--field-id', field);
      const result = runLark(argv);
      const data = result.data || {};
      rows.push(...(data.data || []));
      recordIds.push(...(data.record_id_list || []));
      if (!data.has_more) break;
      offset += 200;
    }
    return { rows, recordIds };
  }

  function writeBatchJson(name, payload) {
    const file = path.join(runtimeDir, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return file;
  }

  function batchCreate(tableId, fields, rows, name) {
    if (rows.length === 0) return { written: 0, recordIds: [] };
    if (dryRun) {
      console.log(`[dry-run] ${name}: ${rows.length} rows`);
      return { written: rows.length, recordIds: [] };
    }
    let written = 0;
    const recordIds = [];
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const file = writeBatchJson(name, { fields, rows: chunk });
      const relPath = path.relative(runtimeDir, file);
      const result = runLark([
        'base', '+record-batch-create', '--as', 'user',
        '--base-token', base.baseToken,
        '--table-id', tableId,
        '--json', `@${relPath}`
      ], { cwd: runtimeDir });
      written += chunk.length;
      // record_id 在 data.record_id_list(与传入 rows 同序的扁平数组)，不在 records[].record_id
      const idList = result?.data?.record_id_list || result?.data?.data?.record_id_list || result?.record_id_list || [];
      // 防错位：飞书返回 id 数少于本批 rows(部分行被拒)时补 null 占位，保证 recordIds[i] 始终对齐 rows[i]，
      // 否则后续批次的截图会整体错位挂到别的记录上
      for (let j = 0; j < chunk.length; j += 1) {
        const id = idList[j];
        recordIds.push(typeof id === 'string' ? id : (id?.record_id || id?.recordId || null));
      }
      if (idList.length !== chunk.length) {
        console.log(`[警告] 飞书 ${name} 本批传 ${chunk.length} 行只回 ${idList.length} 个 record_id，缺的行截图跳过（数据仍写入）`);
      }
    }
    return { written, recordIds };
  }

  // upload 命令 stdout 首行是非 JSON 文本(不能 JSON.parse)，且 --file 只收相对 cwd 的路径
  function uploadShot(tableId, recordId, fieldName, filePath) {
    if (dryRun || !recordId || !filePath || !fs.existsSync(filePath)) return false;
    const result = spawnSync('lark-cli', [
      'base', '+record-upload-attachment', '--as', 'user',
      '--base-token', base.baseToken,
      '--table-id', tableId,
      '--record-id', recordId,
      '--field-id', fieldName,
      '--file', path.basename(filePath)
    ], { cwd: path.dirname(filePath), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (result.status === 0) return true;
    console.log(`[截图回传] ${fieldName} 上传失败：${String(result.stderr || result.stdout || '').split('\n')[0]}`);
    return false;
  }

  // 唯一键单元格可能回来是 ["key"] 富文本数组或 {text} 对象，必须内层解包成字符串，
  // 否则 Set 里存的是数组对象、.has(字符串) 恒 false，去重失效导致每轮重复入库
  const cellStr = (v) => {
    if (Array.isArray(v)) return String(v[0] ?? '');
    if (v && typeof v === 'object') return String(v.link || v.text || '');
    return v == null ? '' : String(v);
  };
  const readKey = (row) => cellStr(Array.isArray(row) ? row[0] : (row?.fields?.['唯一键'] ?? row?.['唯一键']));
  const hasAttachment = (v) => Boolean(v && (!Array.isArray(v) || v.length));

  return {
    kind: 'feishu',
    describe: () => `飞书多维表格 ${base.url || base.baseToken}`,
    loadVideoKeys: () => new Set(listRecordsWithIds(base.tables.videos, ['唯一键']).rows.map(readKey).filter(Boolean)),
    loadCommentKeys: () => new Set(listRecordsWithIds(base.tables.comments, ['唯一键']).rows.map(readKey).filter(Boolean)),
    loadCreatorShotTargets: (creators, keyOf) => {
      const targets = new Map();
      try {
        const { rows, recordIds } = listRecordsWithIds(base.tables.creators, ['博主名', '平台', '主页截图']);
        rows.forEach((row, i) => {
          if (!Array.isArray(row) || !recordIds[i]) return;
          const name = String(row[0] || '');
          const plat = Array.isArray(row[1]) ? row[1][0] : row[1];
          if (name && !hasAttachment(row[2])) targets.set(`${plat}|${name}`, recordIds[i]);
        });
      } catch (error) {
        console.log(`[截图] 读博主清单失败(本轮不补主页截图)：${String(error.message).split('\n')[0]}`);
      }
      return targets;
    },
    saveCreatorShot: (handle, key, shotPath) => uploadShot(base.tables.creators, handle, '主页截图', shotPath),
    saveVideos: (payload, shots) => {
      const result = batchCreate(base.tables.videos, payload.fields, payload.rows, 'videos');
      (shots || []).forEach((shot, i) => {
        const recordId = result.recordIds[i];
        if (recordId && shot) uploadShot(base.tables.videos, recordId, '内容截图', shot);
      });
      return result;
    },
    saveComments: (payload, shots) => {
      const result = batchCreate(base.tables.comments, payload.fields, payload.rows, 'comments');
      let shotUp = 0;
      (shots || []).forEach((shot, i) => {
        const recordId = result.recordIds[i];
        if (recordId && shot && uploadShot(base.tables.comments, recordId, '评论截图', shot)) shotUp += 1;
      });
      if (shotUp > 0) console.log(`[截图回传] 评论截图 ${shotUp} 张`);
      return result;
    },
    saveRunLog: (payload) => batchCreate(base.tables.logs, payload.fields, payload.rows, 'logs')
  };
}

// ============ 工厂 ============

// mode 解析：显式 config.storage.mode 优先；没配但填了 base.baseToken 视为 feishu（老配置兼容）；其余 local
export function createStorage(config, options) {
  const mode = config.storage?.mode || (config.base?.baseToken ? 'feishu' : 'local');
  if (mode === 'feishu') return createFeishuStorage(config, options);
  if (mode === 'local') return createLocalStorage(config, options);
  throw new Error(`未知 storage.mode: ${mode}（可选 local | feishu）`);
}
