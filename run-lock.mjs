import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function readLockSnapshot(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'r');
    const stat = fs.fstatSync(fd);
    const lock = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return { lock, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sameLockSnapshot(left, right) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino) return false;
  const leftOwner = left.lock?.ownerId;
  const rightOwner = right.lock?.ownerId;
  return !leftOwner || !rightOwner || leftOwner === rightOwner;
}

function lockError(message) {
  const error = new Error(message);
  error.code = 'RUN_LOCK_HELD';
  return error;
}

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

export function getProcessStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return '';
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function ownerIsStillLive(lock) {
  const state = processState(lock?.pid);
  if (state === 'dead') return false;
  if (state !== 'live') return true;

  const recordedIdentity = typeof lock.processStartIdentity === 'string'
    ? lock.processStartIdentity
    : '';
  const currentIdentity = getProcessStartIdentity(lock.pid);
  if (recordedIdentity && currentIdentity && recordedIdentity !== currentIdentity) return false;
  return true;
}

export function acquireFileRunLock({
  lockPath,
  tool,
  runId = '',
  argv = process.argv.slice(2),
  heartbeatIntervalMs = 60_000,
  heldMessage = (lock) => `已有任务在运行(pid=${lock?.pid ?? 'unknown'}, ${lock?.tool || 'unknown'})`,
}) {
  const ownerId = randomUUID();
  const startedAt = new Date().toISOString();
  const payload = {
    pid: process.pid,
    tool,
    runId,
    startedAt,
    heartbeatAt: startedAt,
    processStartIdentity: getProcessStartIdentity(process.pid),
    ownerId,
    argv,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      let snapshot = readLockSnapshot(lockPath);
      for (let retry = 0; retry < 3 && snapshot === null; retry += 1) {
        sleepSync(150);
        snapshot = readLockSnapshot(lockPath);
      }
      const lock = snapshot?.lock ?? null;
      if (!lock || ownerIsStillLive(lock)) throw lockError(heldMessage(lock));
      const currentSnapshot = readLockSnapshot(lockPath);
      if (!sameLockSnapshot(snapshot, currentSnapshot)) continue;
      fs.rmSync(lockPath, { force: true });
    }
  }

  const current = readLock(lockPath);
  if (!current || current.ownerId !== ownerId) {
    throw lockError('抢锁两次仍失败，放弃本次运行。');
  }

  const heartbeat = () => {
    const lock = readLock(lockPath);
    if (!lock || lock.ownerId !== ownerId) return false;
    lock.heartbeatAt = new Date().toISOString();
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    return true;
  };

  const timer = heartbeatIntervalMs > 0 ? setInterval(heartbeat, heartbeatIntervalMs) : null;
  timer?.unref();

  return {
    heartbeat,
    release() {
      if (timer) clearInterval(timer);
      const lock = readLock(lockPath);
      if (lock?.ownerId === ownerId) fs.rmSync(lockPath, { force: true });
    },
  };
}
