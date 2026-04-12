import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
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
