import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  effectiveVideoLimit,
  parseRunLimit,
  videoLimitReachedMessage,
} from '../runtime-limits.mjs';

describe('effectiveVideoLimit', () => {
  it('uses the configured per-run limit by default', () => {
    assert.equal(effectiveVideoLimit({ configuredLimit: 14, limitNew: 0, backfill: false }), 14);
  });

  it('reports the smaller explicit limit-new value', () => {
    assert.equal(effectiveVideoLimit({ configuredLimit: 14, limitNew: 1, backfill: false }), 1);
  });

  it('keeps limit-new active during backfill', () => {
    assert.equal(effectiveVideoLimit({ configuredLimit: 14, limitNew: 2, backfill: true }), 2);
  });

  it('has no limit when neither source provides one', () => {
    assert.equal(effectiveVideoLimit({ configuredLimit: 0, limitNew: 0, backfill: false }), Infinity);
  });

  it('formats the reached message from the effective limit', () => {
    const limit = effectiveVideoLimit({ configuredLimit: 14, limitNew: 1, backfill: false });
    assert.equal(videoLimitReachedMessage(limit), '已达到本轮最大新视频处理数：1');
  });

  it('wires the main loop message to the computed effective limit', () => {
    const source = readFileSync(new URL('../run-monitor.mjs', import.meta.url), 'utf8');
    assert.match(source, /console\.log\(videoLimitReachedMessage\(videoRunLimit\)\)/);
  });

  it('rejects explicit limits that could disable the backfill safety valve', () => {
    for (const value of ['-1', '0.5', 'Infinity', 'not-a-number']) {
      assert.throws(() => parseRunLimit(value, '--limit-new'), /--limit-new 必须是 0 或正整数/);
    }
  });

  it('accepts zero and positive integer limits', () => {
    assert.equal(parseRunLimit('0', '--limit-new'), 0);
    assert.equal(parseRunLimit('12', '--limit-new'), 12);
  });
});
