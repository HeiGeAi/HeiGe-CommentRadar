import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createStorage } from '../storage.mjs';

const source = fs.readFileSync(new URL('../run-monitor.mjs', import.meta.url), 'utf8');
const flushSource = source.slice(source.indexOf('function flushCreatorData('), source.indexOf('async function main()'));
const payload = (items) => ({ fields: ['唯一键'], rows: items.map((item) => [item.uniqueKey]) });
const video = (key) => ({ uniqueKey: key });
const comment = (v, key) => ({ uniqueKey: `${v.uniqueKey}:${key}`, video: v });
function runner(storage, dryRun = false) {
  const context = vm.createContext({ storage, dryRun, commentRows: payload, videoRows: payload, console: { log() {} } });
  vm.runInContext(flushSource, context);
  return (videos, comments, videoKeys = new Set(videos.map(v => v.uniqueKey)), commentKeys = new Set(comments.map(c => c.uniqueKey))) => {
    const stats = { insertedComments: 0, insertedVideos: 0 }, errors = [];
    context.flushCreatorData('synthetic', videos, comments, stats, errors, videoKeys, commentKeys);
    return { stats, errors, videoKeys, commentKeys };
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-flush-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const open = () => createStorage({ storage: { mode: 'local' } }, { runtimeDir: path.join(root, '.runtime'), projectDir: root, dryRun: false });
  return { root, open };
}
test('CSV failure leaves video retryable after restart and commits comments exactly once', (t) => {
  const { root, open } = fixture(t), v = video('v1'), c = comment(v, 'c1');
  const storage = open(), csv = path.join(root, '.runtime/data/comments.csv');
  fs.mkdirSync(csv);
  const first = runner(storage)([v], [c]);
  assert.equal(first.videoKeys.size, 0);
  assert.equal(first.commentKeys.size, 0);
  assert.equal(open().loadVideoKeys().size, 0);
  fs.rmdirSync(csv);
  const restarted = open();
  runner(restarted)([v], [c]);
  assert.deepEqual([...open().loadVideoKeys()], ['v1']);
  assert.deepEqual([...open().loadCommentKeys()], ['v1:c1']);
  assert.equal(fs.readFileSync(path.join(root, '.runtime/data/comments.jsonl'), 'utf8').trim().split('\n').length, 1);
});
test('partial comment batch reconciles committed keys and retries only missing comments', () => {
  const a = video('a'), b = video('b'), ca = comment(a, '1'), cb = comment(b, '2');
  const comments = new Set(), videos = new Set(), writes = [];
  let fail = true;
  const storage = {
    loadCommentKeys: () => new Set(comments), loadVideoKeys: () => new Set(videos),
    saveComments(p) {
      for (const [key] of p.rows) {
        comments.add(key); writes.push(key);
        if (fail) { fail = false; throw Error('second chunk failed'); }
      }
      return { written: p.rows.length };
    },
    saveVideos(p) { p.rows.forEach(([key]) => videos.add(key)); return { written: p.rows.length }; },
  };
  const first = runner(storage)([a, b], [ca, cb]);
  assert.deepEqual([...videos], ['a']);
  assert.deepEqual([...first.commentKeys], ['a:1']);
  assert.deepEqual([...first.videoKeys], ['a']);
  assert.equal(first.stats.insertedComments, 1);
  runner(storage)([b], [cb].filter(c => !storage.loadCommentKeys().has(c.uniqueKey)));
  assert.deepEqual(writes, ['a:1', 'b:2']);
  assert.equal(videos.size, 2);
});
test('video failure keeps committed comments and retries marker without duplicates', (t) => {
  const { open } = fixture(t), storage = open(), v = video('v'), c = comment(v, 'c');
  const first = runner({ ...storage, saveVideos() { throw Error('video write failed'); } })([v], [c]);
  assert.equal(first.videoKeys.size, 0);
  assert.equal(first.commentKeys.size, 1);
  const restarted = open();
  runner(restarted)([v], [c].filter(c => !restarted.loadCommentKeys().has(c.uniqueKey)));
  assert.equal(open().loadVideoKeys().size, 1);
  assert.equal(open().loadCommentKeys().size, 1);
});
test('short write is reconciled and does not commit an incomplete video', () => {
  const v = video('v'), c = comment(v, 'c');
  const result = runner({ saveComments: () => ({ written: 0 }), loadCommentKeys: () => new Set(), saveVideos() { assert.fail('unsafe marker'); } })([v], [c]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.videoKeys.size, 0);
});
test('reconciliation failure aborts without writing video markers', () => {
  const v = video('v'), c = comment(v, 'c');
  assert.throws(() => runner({ saveComments() { throw Error('write'); }, loadCommentKeys() { throw Error('read'); }, saveVideos() { assert.fail('unsafe marker'); } })([v], [c]), /read/);
});
test('no comments and dry-run preserve intended behavior', () => {
  const v = video('v');
  assert.equal(runner({ saveVideos: () => ({ written: 1 }) })([v], []).stats.insertedVideos, 1);
  const result = runner({ saveComments: () => ({ written: 0 }), saveVideos: () => ({ written: 0 }) }, true)([v], [comment(v, 'c')]);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.stats, { insertedComments: 0, insertedVideos: 0 });
});
test('partially written comments for one video remain retryable without duplicate committed rows', () => {
  const v = video('v'), items = [comment(v, '1'), comment(v, '2')], committed = new Set(), writes = [];
  let partial = true;
  const storage = {
    loadCommentKeys: () => new Set(committed),
    saveComments(p) {
      for (const [key] of p.rows) {
        committed.add(key); writes.push(key);
        if (partial) { partial = false; throw Error('partial batch'); }
      }
      return { written: p.rows.length };
    },
    saveVideos: () => ({ written: 1 }),
  };
  const first = runner(storage)([v], items);
  assert.equal(first.videoKeys.size, 0);
  assert.deepEqual([...first.commentKeys], ['v:1']);
  const second = runner(storage)([v], items.filter(item => !storage.loadCommentKeys().has(item.uniqueKey)));
  assert.equal(second.stats.insertedVideos, 1);
  assert.deepEqual(writes, ['v:1', 'v:2']);
});
test('partial video write retains only durable video keys', () => {
  const a = video('a'), b = video('b');
  const first = runner({ saveVideos() { throw Error('partial video batch'); }, loadVideoKeys: () => new Set(['a']) })([a, b], []);
  assert.deepEqual([...first.videoKeys], ['a']);
  assert.equal(first.stats.insertedVideos, 1);
});
