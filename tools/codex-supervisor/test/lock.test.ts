import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectCycleLock } from "../src/infra/lock.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) {
      await rm(target, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-supervisor-lock-"));
  tempRoots.push(root);
  return root;
}

describe("cycle lock inspection", () => {
  it("does not mark a lock stale when pid probing fails with EPERM", async () => {
    const root = await makeTempDir();
    const lockPath = join(root, "cycle.lock");
    await writeFile(lockPath, `${JSON.stringify({
      owner: "tester",
      command: "codex-autonomy worker",
      pid: 4242,
      hostname: "host",
      started_at: "2099-01-01T00:00:00.000Z",
    }, null, 2)}\n`, "utf8");

    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    const inspection = await inspectCycleLock(lockPath);

    expect(inspection.exists).toBe(true);
    expect(inspection.stale).toBe(false);
  });

  it("still marks a lock stale by age when pid probing fails with EPERM", async () => {
    const root = await makeTempDir();
    const lockPath = join(root, "cycle.lock");
    await writeFile(lockPath, `${JSON.stringify({
      owner: "tester",
      command: "codex-autonomy worker",
      pid: 4242,
      hostname: "host",
      started_at: "2000-01-01T00:00:00.000Z",
    }, null, 2)}\n`, "utf8");

    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    const inspection = await inspectCycleLock(lockPath, 1);

    expect(inspection.exists).toBe(true);
    expect(inspection.stale).toBe(true);
  });
});
