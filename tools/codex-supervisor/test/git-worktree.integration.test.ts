import { appendFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBootstrapCommand } from "../src/commands/bootstrap.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runPrepareWorktree } from "../src/commands/prepare-worktree.js";
import { runStatusCommand } from "../src/commands/status.js";
import { DEFAULT_BACKGROUND_WORKTREE_BRANCH, getBackgroundWorktreePath } from "../src/infra/git.js";

const runtimeMocks = vi.hoisted(() => ({
  inspectCycleLockMock: vi.fn(),
  discoverPowerShellExecutableMock: vi.fn(),
  detectCodexProcessMock: vi.fn(),
}));

vi.mock("../src/infra/lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/lock.js")>();
  return {
    ...actual,
    inspectCycleLock: runtimeMocks.inspectCycleLockMock,
  };
});

vi.mock("../src/infra/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/process.js")>();
  return {
    ...actual,
    discoverPowerShellExecutable: runtimeMocks.discoverPowerShellExecutableMock,
    detectCodexProcess: runtimeMocks.detectCodexProcessMock,
  };
});

const tempRoots: string[] = [];
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(async () => {
  restoreEnv("GIT_CONFIG_GLOBAL", originalGitConfigGlobal);
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) {
      await rm(target, { recursive: true, force: true });
    }
  }
});

beforeEach(() => {
  runtimeMocks.inspectCycleLockMock.mockReset();
  runtimeMocks.discoverPowerShellExecutableMock.mockReset();
  runtimeMocks.detectCodexProcessMock.mockReset();
  runtimeMocks.inspectCycleLockMock.mockResolvedValue({
    exists: false,
    stale: false,
  });
  runtimeMocks.discoverPowerShellExecutableMock.mockReturnValue("pwsh");
  runtimeMocks.detectCodexProcessMock.mockReturnValue({
    running: true,
    matches: ["Codex"],
    executable: "pwsh",
    probeOk: true,
  });
});

async function makeTempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-supervisor-"));
  tempRoots.push(root);
  return root;
}

function restoreEnv(name: "GIT_CONFIG_GLOBAL" | "HOME" | "USERPROFILE", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error([
      `git ${args.join(" ")} failed in ${cwd}`,
      `stdout:\n${result.stdout ?? ""}`,
      `stderr:\n${result.stderr ?? ""}`,
    ].join("\n"));
  }

  return (result.stdout ?? "").trim();
}

describe("git/worktree integration", () => {
  it("covers git init, bootstrap, commit, prepare-worktree, status, and worktree alignment", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    const bootstrap = await runBootstrapCommand(workspace);
    expect(bootstrap.ok).toBe(true);

    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);

    const firstHead = runGit(workspace, ["rev-parse", "HEAD"]);
    const firstPrepare = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(firstPrepare.ok).toBe(true);
    expect(firstPrepare.action).toBe("created");
    expect(firstPrepare.branch).toBe(DEFAULT_BACKGROUND_WORKTREE_BRANCH);
    expect(firstPrepare.head).toBe(firstHead);
    expect(firstPrepare.backgroundPath).toBe(getBackgroundWorktreePath(workspace));
    expect(firstPrepare.backgroundPath).not.toBeNull();
    if (firstPrepare.backgroundPath) {
      tempRoots.push(firstPrepare.backgroundPath);
    }
    const safeDirectoriesAfterCreate = runGit(workspace, ["config", "--global", "--get-all", "safe.directory"])
      .split(/\r?\n/)
      .filter(Boolean);
    expect(safeDirectoriesAfterCreate).toContain(workspace.replace(/\\/g, "/"));
    expect(safeDirectoriesAfterCreate).toContain(getBackgroundWorktreePath(workspace).replace(/\\/g, "/"));

    const status = await runStatusCommand(workspace);
    expect(status.ready_for_automation).toBe(false);
    expect((status.warnings ?? []).some((warning) => warning.code === "missing_background_worktree")).toBe(false);
    expect((status.warnings ?? []).some((warning) => warning.code === "background_worktree_head_mismatch")).toBe(false);
    expect((status.warnings ?? []).some((warning) => warning.code === "unexpected_background_branch")).toBe(false);

    await appendFile(join(workspace, "README.md"), "\n<!-- integration test change -->\n", "utf8");
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "advance main repo"]);

    const secondHead = runGit(workspace, ["rev-parse", "HEAD"]);
    const secondPrepare = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(secondPrepare.ok).toBe(true);
    expect(secondPrepare.action).toBe("aligned");
    expect(secondPrepare.head).toBe(secondHead);
    expect(secondPrepare.backgroundPath).toBe(firstPrepare.backgroundPath);

    if (!secondPrepare.backgroundPath) {
      throw new Error("Expected prepare-worktree to return a background path.");
    }

    const alignedHead = runGit(secondPrepare.backgroundPath, ["rev-parse", "HEAD"]);
    expect(alignedHead).toBe(secondHead);
  });

  it("rejects redirected background worktree paths", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    const redirectedTarget = await makeTempWorkspace();
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);
    await runBootstrapCommand(workspace);
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);

    const backgroundPath = getBackgroundWorktreePath(workspace);
    await symlink(redirectedTarget, backgroundPath, "junction");
    tempRoots.push(backgroundPath);

    const result = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/redirected|symbolic link|junction/i);
  });

  it("rejects dangling redirected background worktree paths", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    const redirectedRoot = await makeTempWorkspace();
    const missingRedirectTarget = join(redirectedRoot, "missing-background-target");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);
    await runBootstrapCommand(workspace);
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);

    const backgroundPath = getBackgroundWorktreePath(workspace);
    await symlink(missingRedirectTarget, backgroundPath, "junction");
    tempRoots.push(backgroundPath);

    const result = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/redirected|symbolic link|junction/i);
  });

  it("status and doctor reject redirected existing background worktree paths", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    const redirectedRoot = await makeTempWorkspace();
    const redirectedTarget = join(redirectedRoot, "redirected-worktree");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);
    await runBootstrapCommand(workspace);
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);

    runGit(workspace, ["worktree", "add", "-B", "redirected/worktree", redirectedTarget, "HEAD"]);

    const backgroundPath = getBackgroundWorktreePath(workspace);
    await symlink(redirectedTarget, backgroundPath, "junction");
    tempRoots.push(backgroundPath);

    const status = await runStatusCommand(workspace);
    const doctor = await runDoctor({ workspaceRoot: workspace });

    expect(status.ready_for_automation).toBe(false);
    expect((status.warnings ?? []).some((warning) => warning.code === "unsafe_background_worktree_path")).toBe(true);
    expect(doctor.ok).toBe(false);
    expect(doctor.issues.some((issue) => issue.code === "unsafe_background_worktree_path")).toBe(true);
  });
});
