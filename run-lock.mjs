import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const RECLAIM_GUARD_WAIT_MS = 150;
const INVALID_GUARD_STALE_MS = 30_000;

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

function lockError(message) {
  const error = new Error(message);
  error.code = 'RUN_LOCK_HELD';
  return error;
}

function publishGuardFile(target, payload, { replace = false } = {}) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
    fs.fsyncSync(fd);
    if (replace) fs.renameSync(temporary, target);
    else fs.linkSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function guardParticipant(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return { path: lockPath, lock, invalid: false, mtimeMs: stat.mtimeMs };
  } catch {
    try {
      return {
        path: lockPath,
        lock: null,
        invalid: true,
        mtimeMs: fs.statSync(lockPath).mtimeMs,
      };
    } catch {
      return null;
    }
  }
}

function activeGuardParticipants(guardDirectory) {
  let names;
  try {
    names = fs.readdirSync(guardDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const participants = [];
  for (const name of names) {
    if (!name.endsWith('.claim.json')) continue;
    const participant = guardParticipant(path.join(guardDirectory, name));
    if (!participant) continue;
    if (participant.invalid) {
      if (Date.now() - participant.mtimeMs >= INVALID_GUARD_STALE_MS) {
        fs.rmSync(participant.path, { force: true });
      } else {
        participants.push(participant);
      }
      continue;
    }
    if (!ownerIsStillLive(participant.lock)) {
      fs.rmSync(participant.path, { force: true });
      continue;
    }
    participants.push(participant);
  }
  return participants;
}

function acquireReclaimGuard(lockPath) {
  const guardDirectory = `${lockPath}.reclaim`;
  fs.mkdirSync(guardDirectory, { recursive: true });
  const ownerId = randomUUID();
  const identity = {
    pid: process.pid,
    ownerId,
    processStartIdentity: getProcessStartIdentity(process.pid),
  };
  const participantPath = path.join(guardDirectory, `${ownerId}.claim.json`);
  const cleanup = () => {
    fs.rmSync(participantPath, { force: true });
  };

  try {
    publishGuardFile(participantPath, { ...identity, choosing: true, ticket: 0 });
    const tickets = activeGuardParticipants(guardDirectory)
      .filter((participant) => participant.lock?.choosing === false)
      .map((participant) => Number(participant.lock?.ticket) || 0);
    const ticket = Math.max(0, ...tickets) + 1;
    publishGuardFile(
      participantPath,
      { ...identity, choosing: false, ticket },
      { replace: true },
    );

    const deadline = Date.now() + RECLAIM_GUARD_WAIT_MS;
    while (true) {
      const blocked = activeGuardParticipants(guardDirectory).some((participant) => {
        if (participant.lock?.ownerId === ownerId) return false;
        if (participant.invalid || participant.lock?.choosing !== false) return true;
        const otherTicket = Number(participant.lock?.ticket);
        if (!Number.isSafeInteger(otherTicket) || otherTicket <= 0) return true;
        return otherTicket < ticket
          || (otherTicket === ticket && participant.lock.ownerId < ownerId);
      });
      if (!blocked) {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          cleanup();
        };
      }
      if (Date.now() >= deadline) {
        throw lockError('另一个回收事务正在处理运行锁。');
      }
      sleepSync(10);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
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
      const releaseReclaimGuard = acquireReclaimGuard(lockPath);
      let publishedUnderGuard = false;
      try {
        const currentSnapshot = readLockSnapshot(lockPath);
        const currentLock = currentSnapshot?.lock ?? null;
        if (!currentLock || ownerIsStillLive(currentLock)) {
          throw lockError(heldMessage(currentLock));
        }
        fs.rmSync(lockPath, { force: true });
        try {
          fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { flag: 'wx' });
          publishedUnderGuard = true;
        } catch (publishError) {
          if (publishError.code !== 'EEXIST') throw publishError;
        }
      } finally {
        releaseReclaimGuard();
      }
      if (publishedUnderGuard) break;
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
