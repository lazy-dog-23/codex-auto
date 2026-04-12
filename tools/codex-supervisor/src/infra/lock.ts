import { open, unlink } from 'node:fs/promises';
import { ensureParentDirectory, pathExists, readJsonFile } from './json.js';
import { currentHostname, currentUserName } from './process.js';
import type { CycleLockHandle, CycleLockInspection, CycleLockRecord } from './types.js';

export const DEFAULT_CYCLE_LOCK_STALE_AFTER_MS = 45 * 60 * 1000;

export interface AcquireCycleLockOptions {
  owner?: string;
  command: string;
  staleAfterMs?: number;
  pid?: number;
  hostname?: string;
}

export type AcquireCycleLockInput = string | AcquireCycleLockOptions;

export async function inspectCycleLock(
  lockPath: string,
  staleAfterMs = DEFAULT_CYCLE_LOCK_STALE_AFTER_MS,
): Promise<CycleLockInspection> {
  if (!(await pathExists(lockPath))) {
    return {
      path: lockPath,
      exists: false,
      stale: false,
    };
  }

  let record: CycleLockRecord | null = null;

  try {
    record = await readJsonFile<CycleLockRecord>(lockPath);
  } catch (error) {
    return {
      path: lockPath,
      exists: true,
      stale: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const staleReason = getStaleLockReason(record, staleAfterMs);
  return {
    path: lockPath,
    exists: true,
    stale: Boolean(staleReason),
    reason: staleReason ?? undefined,
    record,
  };
}

export async function acquireCycleLock(
  lockPath: string,
  options: AcquireCycleLockInput,
): Promise<CycleLockHandle> {
  const normalizedOptions: AcquireCycleLockOptions =
    typeof options === 'string' ? { command: options } : options;
  const staleAfterMs = normalizedOptions.staleAfterMs ?? DEFAULT_CYCLE_LOCK_STALE_AFTER_MS;
  await ensureParentDirectory(lockPath);

  while (true) {
    try {
      const fd = await open(lockPath, 'wx');
      const record: CycleLockRecord = {
        owner: normalizedOptions.owner ?? currentUserName(),
        command: normalizedOptions.command,
        pid: normalizedOptions.pid ?? process.pid,
        hostname: normalizedOptions.hostname ?? currentHostname(),
        started_at: new Date().toISOString(),
      };
      await fd.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await fd.sync();
      await fd.close();
      return {
        path: lockPath,
        record,
        staleAfterMs,
        release: async () => {
          await releaseCycleLock(lockPath, record);
        },
      };
    } catch (error) {
      const inspection = await inspectCycleLock(lockPath, staleAfterMs);
      if (!inspection.exists || !inspection.stale) {
        throw buildLockError(lockPath, inspection, error);
      }

      await removeStaleLock(lockPath);
    }
  }
}

export async function releaseCycleLock(
  lockPath: string,
  record?: CycleLockRecord | CycleLockHandle | null,
): Promise<void> {
  const normalizedRecord = normalizeLockRecord(record);
  const inspection = await inspectCycleLock(lockPath);
  if (!inspection.exists) {
    return;
  }

  if (normalizedRecord && inspection.record) {
    const sameOwner =
      inspection.record.pid === normalizedRecord.pid &&
      inspection.record.owner === normalizedRecord.owner &&
      inspection.record.command === normalizedRecord.command &&
      inspection.record.hostname === normalizedRecord.hostname;

    if (!sameOwner) {
      return;
    }
  }

  await unlink(lockPath).catch(() => {
    // Another process may have already removed or replaced the lock.
  });
}

export async function loadCycleLock(lockPath: string): Promise<CycleLockRecord | null> {
  if (!(await pathExists(lockPath))) {
    return null;
  }

  try {
    return await readJsonFile<CycleLockRecord>(lockPath);
  } catch {
    return null;
  }
}

function getStaleLockReason(record: CycleLockRecord | null, staleAfterMs: number): string | null {
  if (!record) {
    return 'lock file content is missing';
  }

  if (!Number.isInteger(record.pid) || record.pid <= 0) {
    return 'lock pid is invalid';
  }

  if (!record.started_at || Number.isNaN(Date.parse(record.started_at))) {
    return 'lock started_at is invalid';
  }

  if (isLockProcessGone(record.pid)) {
    return `lock process ${record.pid} is no longer running`;
  }

  const startedAt = Date.parse(record.started_at);
  const age = Date.now() - startedAt;
  if (age > staleAfterMs) {
    return `lock is older than ${staleAfterMs}ms`;
  }

  return null;
}

function isLockProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      return true;
    }
    return true;
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => {
    // Stale lock may have already been removed by a concurrent process.
  });
}

function buildLockError(lockPath: string, inspection: CycleLockInspection, error: unknown): Error {
  const suffix = inspection.reason ? `: ${inspection.reason}` : '';
  const base = `Unable to acquire cycle lock at ${lockPath}${suffix}`;
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(`${base}. Cause: ${cause}`);
}

function normalizeLockRecord(record?: CycleLockRecord | CycleLockHandle | null): CycleLockRecord | null {
  if (!record) {
    return null;
  }

  if ('record' in record) {
    return record.record;
  }

  return record;
}
