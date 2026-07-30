import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStorage } from '../storage.mjs';

const payload = (key) => ({
  fields: ['唯一键', '评论正文'],
  rows: [[key, '真实评论']],
});

function localStorageAt(root) {
  return createStorage(
    { storage: { mode: 'local' } },
    { runtimeDir: path.join(root, '.runtime'), projectDir: root, dryRun: false },
  );
}

test('local comment keys survive a clean storage restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-radar-storage-'));
  try {
    const first = localStorageAt(root);
    assert.equal(first.saveComments(payload('video-1:comment-1'), ['']).written, 1);

    const restarted = localStorageAt(root);
    assert.deepEqual([...restarted.loadCommentKeys()], ['video-1:comment-1']);
    assert.ok(fs.statSync(path.join(root, '.runtime/data/comments.jsonl')).size > 0);
    assert.ok(fs.statSync(path.join(root, '.runtime/data/comments.csv')).size > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed CSV write does not leave a dedupe key that blocks retry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-radar-recovery-'));
  try {
    const storage = localStorageAt(root);
    const csvPath = path.join(root, '.runtime/data/comments.csv');
    fs.mkdirSync(csvPath);

    assert.throws(() => storage.saveComments(payload('video-2:comment-2'), ['']), /EISDIR|illegal operation/i);
    assert.equal(localStorageAt(root).loadCommentKeys().has('video-2:comment-2'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
