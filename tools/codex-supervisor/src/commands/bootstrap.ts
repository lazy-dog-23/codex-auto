import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import type { BlockersDocument, CommandResult, TasksDocument } from "../contracts/autonomy.js";
import { writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { blockersSchema, stateSchema, tasksSchema } from "../schemas/index.js";
import { resolveRepoPaths } from "../shared/paths.js";
import {
  getAgentsMarkdown,
  getAutonomyPlanSkillMarkdown,
  getAutonomyWorkSkillMarkdown,
  getConfigTomlTemplate,
  getDefaultGoalMarkdown,
  getDefaultJournalMarkdown,
  getEnvironmentTomlTemplate,
  getSetupWindowsScriptTemplate,
  getSmokeScriptTemplate,
  getVerifyScriptTemplate,
} from "../scaffold/templates.js";

const DEFAULT_TASKS: TasksDocument = {
  version: 1,
  tasks: []
};

const DEFAULT_BLOCKERS: BlockersDocument = {
  version: 1,
  blockers: []
};

const DEFAULT_STATE = {
  version: 1,
  current_task_id: null,
  cycle_status: "idle",
  last_planner_run_at: null,
  last_worker_run_at: null,
  last_result: "noop",
  consecutive_worker_failures: 0,
  needs_human_review: false,
  open_blocker_count: 0
};

async function ensureTextFile(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return false;
  } catch {
    await writeTextFileAtomic(filePath, content);
    return true;
  }
}

async function ensureJsonFile(filePath: string, value: unknown): Promise<boolean> {
  try {
    await fs.access(filePath);
    return false;
  } catch {
    await writeJsonAtomic(filePath, value);
    return true;
  }
}

export async function runBootstrapCommand(repoRoot = process.cwd()): Promise<CommandResult> {
  const paths = resolveRepoPaths(repoRoot);
  const created: string[] = [];
  const planSkillFile = path.join(repoRoot, ".agents", "skills", "$autonomy-plan", "SKILL.md");
  const workSkillFile = path.join(repoRoot, ".agents", "skills", "$autonomy-work", "SKILL.md");
  const tasksSchemaFile = path.join(paths.schemaDir, "tasks.schema.json");
  const stateSchemaFile = path.join(paths.schemaDir, "state.schema.json");
  const blockersSchemaFile = path.join(paths.schemaDir, "blockers.schema.json");
  const cycleLockKeepFile = path.join(paths.locksDir, ".gitkeep");

  const directories = [
    paths.autonomyDir,
    paths.schemaDir,
    paths.locksDir,
    paths.scriptsDir,
    paths.codexDir,
    path.dirname(paths.environmentFile),
    path.dirname(planSkillFile),
    path.dirname(workSkillFile),
    paths.cliDir,
  ];

  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
  }

  const textFileEntries: Array<[string, string]> = [
    [paths.agentsFile, getAgentsMarkdown() + "\n"],
    [planSkillFile, getAutonomyPlanSkillMarkdown() + "\n"],
    [workSkillFile, getAutonomyWorkSkillMarkdown() + "\n"],
    [paths.goalFile, getDefaultGoalMarkdown() + "\n"],
    [paths.journalFile, getDefaultJournalMarkdown() + "\n"],
    [paths.environmentFile, getEnvironmentTomlTemplate() + "\n"],
    [paths.configFile, getConfigTomlTemplate() + "\n"],
    [paths.setupScript, getSetupWindowsScriptTemplate()],
    [paths.verifyScript, getVerifyScriptTemplate()],
    [paths.smokeScript, getSmokeScriptTemplate()],
    [cycleLockKeepFile, "\n"],
  ];

  for (const [filePath, content] of textFileEntries) {
    if (await ensureTextFile(filePath, content)) {
      created.push(filePath);
    }
  }

  const jsonFileEntries: Array<[string, unknown]> = [
    [paths.tasksFile, DEFAULT_TASKS],
    [paths.stateFile, DEFAULT_STATE],
    [paths.blockersFile, DEFAULT_BLOCKERS],
    [tasksSchemaFile, tasksSchema],
    [stateSchemaFile, stateSchema],
    [blockersSchemaFile, blockersSchema],
  ];

  for (const [filePath, value] of jsonFileEntries) {
    if (await ensureJsonFile(filePath, value)) {
      created.push(filePath);
    }
  }

  const isGitRepo = await fs
    .access(path.join(repoRoot, ".git"))
    .then(() => true)
    .catch(() => false);

  const warningMessage = isGitRepo
    ? "Bootstrap completed."
    : "Bootstrap completed with warning: current directory is not a Git repository, so worktree-based automation remains disabled.";

  return {
    ok: true,
    message: warningMessage,
    warnings: created.length === 0 ? [] : [{ code: "created_files", message: `${created.length} files were created.` }]
  };
}

export function registerBootstrapCommand(program: Command): void {
  program
    .command("bootstrap")
    .description("Create missing autonomy scaffolding in the current repository")
    .action(async () => {
      const result = await runBootstrapCommand();
      console.log(JSON.stringify(result, null, 2));
    });
}
