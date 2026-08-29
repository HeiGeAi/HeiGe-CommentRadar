import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, describe, it } from 'node:test';

import {
  effectiveVideoLimit,
  parseRunLimit,
  videoLimitReachedMessage,
} from '../runtime-limits.mjs';
import {
  acquireFileRunLock,
  getProcessStartIdentity,
} from '../run-lock.mjs';

const temporaryRoots = [];
const childProcesses = [];

after(async () => {
  for (const child of childProcesses) {
    if (child.exitCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function tempLockPath(label) {
  const root = mkdtempSync(path.join(tmpdir(), `comment-radar-${label}-`));
  temporaryRoots.push(root);
  return path.join(root, 'run.lock.json');
}

async function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  childProcesses.push(child);
  await once(child, 'spawn');
  return child;
}

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

describe('shared long-running lock', () => {
  it('does not let run-monitor expire a live owner only because the lock is old', () => {
    const source = readFileSync(new URL('../run-monitor.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /processExists\(lock\.pid\)\s*&&\s*!tooOld/);
  });

  it('does not let backfill expire a live owner only because the lock is old', () => {
    const source = readFileSync(new URL('../backfill-shots.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /lock\.pid !== process\.pid\s*&&\s*!tooOld/);
  });

  for (const tool of ['run-monitor', 'backfill-shots']) {
    it(`${tool} preserves a lock older than 24 hours while its PID is alive`, async () => {
      const child = await liveChild();
      const lockPath = tempLockPath(`${tool}-live`);
      const oldTimestamp = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const original = {
        pid: child.pid,
        tool: 'existing-owner',
        runId: 'existing-run',
        startedAt: oldTimestamp,
        heartbeatAt: oldTimestamp,
        processStartIdentity: getProcessStartIdentity(child.pid),
      };
      writeFileSync(lockPath, JSON.stringify(original));

      assert.throws(
        () => acquireFileRunLock({ lockPath, tool, runId: `new-${tool}`, heartbeatIntervalMs: 0 }),
        (error) => error?.code === 'RUN_LOCK_HELD',
      );
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), original);
    });
  }

  it('reclaims a lock only after its recorded PID is confirmed dead', async () => {
    const child = await liveChild();
    const deadPid = child.pid;
    const deadIdentity = getProcessStartIdentity(deadPid);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;

    const lockPath = tempLockPath('dead');
    const oldTimestamp = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      tool: 'dead-owner',
      runId: 'dead-run',
      startedAt: oldTimestamp,
      heartbeatAt: oldTimestamp,
      processStartIdentity: deadIdentity,
    }));

    const lease = acquireFileRunLock({
      lockPath,
      tool: 'run-monitor',
      runId: 'replacement-run',
      heartbeatIntervalMs: 0,
    });
    const replacement = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(replacement.pid, process.pid);
    assert.equal(replacement.tool, 'run-monitor');
    assert.equal(typeof replacement.processStartIdentity, 'string');
    assert.equal(typeof replacement.heartbeatAt, 'string');

    lease.release();
    assert.equal(existsSync(lockPath), false);
  });

  it('does not delete a competitor lock created after the stale-owner check', () => {
    const lockPath = tempLockPath('reclaim-race');
    const deadPid = 99_999_999;
    writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      tool: 'dead-owner',
      ownerId: 'dead-owner-id',
      processStartIdentity: 'dead-start',
    }));
    const competitor = {
      pid: process.pid,
      tool: 'competitor',
      ownerId: 'competitor-owner-id',
      processStartIdentity: getProcessStartIdentity(process.pid),
    };
    const originalKill = process.kill;
    let injected = false;
    process.kill = (pid, signal) => {
      if (!injected && pid === deadPid && signal === 0) {
        injected = true;
        rmSync(lockPath, { force: true });
        writeFileSync(lockPath, JSON.stringify(competitor));
        const error = new Error('injected dead owner');
        error.code = 'ESRCH';
        throw error;
      }
      return originalKill.call(process, pid, signal);
    };
    try {
      assert.throws(
        () => acquireFileRunLock({
          lockPath,
          tool: 'late-reclaimer',
          heartbeatIntervalMs: 0,
        }),
        (error) => error?.code === 'RUN_LOCK_HELD',
      );
      assert.equal(injected, true);
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), competitor);
    } finally {
      process.kill = originalKill;
    }
  });

  it('reclaims a reused live PID when the process start identity changed', () => {
    const lockPath = tempLockPath('pid-reuse');
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      tool: 'reused-pid-owner',
      ownerId: 'reused-pid-owner-id',
      processStartIdentity: 'not-the-current-process-start',
    }));

    const lease = acquireFileRunLock({
      lockPath,
      tool: 'replacement-after-pid-reuse',
      heartbeatIntervalMs: 0,
    });
    const replacement = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(replacement.tool, 'replacement-after-pid-reuse');
    assert.notEqual(replacement.ownerId, 'reused-pid-owner-id');
    lease.release();
  });

  it('keeps a live lock when process start identity cannot be read', () => {
    const lockPath = tempLockPath('identity-unavailable');
    const original = {
      pid: process.pid,
      tool: 'identity-unavailable-owner',
      ownerId: 'identity-unavailable-owner-id',
      processStartIdentity: 'recorded-process-start',
    };
    writeFileSync(lockPath, JSON.stringify(original));
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      assert.throws(
        () => acquireFileRunLock({
          lockPath,
          tool: 'must-not-reclaim-unknown-identity',
          heartbeatIntervalMs: 0,
        }),
        (error) => error?.code === 'RUN_LOCK_HELD',
      );
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), original);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
