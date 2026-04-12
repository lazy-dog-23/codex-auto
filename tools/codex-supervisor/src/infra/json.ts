import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { access, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await assertDirectPathBoundary(filePath);
  await mkdir(dirname(filePath), { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  await assertDirectPathBoundary(filePath);
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${filePath}: ${message}`);
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options?: { indent?: number },
): Promise<void> {
  await ensureParentDirectory(filePath);
  const indent = options?.indent ?? 2;
  const payload = `${JSON.stringify(value, null, indent)}\n`;
  const tempPath = join(dirname(filePath), `.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, payload, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup failures; the primary error is more useful.
    }
    throw error;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

export async function readTextFile(filePath: string): Promise<string> {
  await assertDirectPathBoundary(filePath);
  return readFile(filePath, 'utf8');
}

export async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  await ensureParentDirectory(filePath);
  const tempPath = join(dirname(filePath), `.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

export async function isFile(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

export async function listDirectoryEntries(filePath: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(filePath);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

export async function assertDirectPathBoundary(filePath: string): Promise<void> {
  let current = resolve(filePath);
  let label = 'target path';

  while (true) {
    try {
      await assertExistingPathIsDirect(current, label);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return;
    }

    current = parent;
    label = 'ancestor path';
  }
}

async function assertExistingPathIsDirect(targetPath: string, label: string): Promise<void> {
  const stats = await lstat(targetPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing redirected ${label}: ${targetPath} is a symbolic link or junction.`);
  }

  const resolvedTarget = normalizePathForComparison(targetPath);
  const canonicalTarget = normalizePathForComparison(await realpath(targetPath));
  if (resolvedTarget !== canonicalTarget) {
    throw new Error(`Refusing redirected ${label}: ${targetPath} resolves to ${canonicalTarget}.`);
  }
}

function normalizePathForComparison(targetPath: string): string {
  const normalized = resolve(targetPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
