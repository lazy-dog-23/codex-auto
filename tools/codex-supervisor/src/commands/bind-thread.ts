import { Command } from "commander";

import type { CommandResult } from "../contracts/autonomy.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { appendJournalEntry } from "../infra/journal.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { loadStateDocument, writeStateDocument } from "./control-plane.js";

interface BindThreadOptions {
  workspaceRoot?: string;
  reportThreadId?: string;
}

export async function runBindThreadCommand(
  options: BindThreadOptions = {},
  repoRoot = process.cwd(),
): Promise<CommandResult> {
  const reportThreadId = options.reportThreadId?.trim();
  if (!reportThreadId) {
    throw new CliError("bind-thread requires --report-thread-id.", CLI_EXIT_CODES.usage);
  }

  const gitRepo = await detectGitRepository(options.workspaceRoot?.trim() || repoRoot);
  const controlRoot = gitRepo?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy bind-thread");

  try {
    const now = new Date().toISOString();
    const state = await loadStateDocument(paths);
    const previousThreadId = state.report_thread_id?.trim() || null;
    const updatedState = {
      ...state,
      report_thread_id: reportThreadId,
    };

    await writeStateDocument(paths, updatedState);
    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId: "bind-thread",
      result: previousThreadId === reportThreadId ? "noop" : "passed",
      summary: previousThreadId === reportThreadId
        ? `report_thread_id was already bound to ${reportThreadId}.`
        : `Bound report_thread_id to ${reportThreadId}.`,
      verify: "not run (codex-autonomy bind-thread)",
      blocker: "none",
    });

    return {
      ok: true,
      message: previousThreadId === reportThreadId
        ? `report_thread_id was already bound to ${reportThreadId}.`
        : `Bound report_thread_id to ${reportThreadId}.`,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerBindThreadCommand(program: Command): void {
  program
    .command("bind-thread")
    .requiredOption("--report-thread-id <id>", "Report thread id to bind")
    .option("--workspace-root <path>", "Workspace root to inspect")
    .description("Bind the originating thread id directly in the repo control plane")
    .action(async (options: BindThreadOptions) => {
      const result = await runBindThreadCommand(options);
      console.log(JSON.stringify(result, null, 2));
    });
}
