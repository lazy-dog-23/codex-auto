import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { isDirectory, pathExists, writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoPaths, resolveRepoRoot } from "../shared/paths.js";
import {
  blockersSchema,
  goalsSchema,
  proposalsSchema,
  resultsSchema,
  settingsSchema,
  stateSchema,
  tasksSchema,
} from "../schemas/index.js";
import {
  getAgentsMarkdown,
  getAutonomyIntakeSkillMarkdown,
  getAutonomyPlanSkillMarkdown,
  getAutonomyReportSkillMarkdown,
  getAutonomyReviewSkillMarkdown,
  getAutonomySprintSkillMarkdown,
  getAutonomyWorkSkillMarkdown,
  getConfigTomlTemplate,
  getEnvironmentTomlTemplate,
  getInstallGoalMarkdown,
  getInstallVerifyScriptTemplate,
  getReviewScriptTemplate,
  getSetupWindowsScriptTemplate,
  getSmokeScriptTemplate,
  getDefaultJournalMarkdown,
} from "../scaffold/templates.js";
import {
  createDefaultGoalsDocument,
  createDefaultProposalsDocument,
  createDefaultResultsDocument,
  createDefaultSettingsDocument,
  createDefaultState,
} from "./control-plane.js";
import type { BlockersDocument, TasksDocument } from "../contracts/autonomy.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TASKS: TasksDocument = {
  version: 1,
  tasks: [],
};

const DEFAULT_BLOCKERS: BlockersDocument = {
  version: 1,
  blockers: [],
};

interface InstallOptions {
  target?: string;
}

export async function runInstallCommand(options: InstallOptions = {}): Promise<{ ok: boolean; message: string; warnings?: Array<{ code: string; message: string }> }> {
  const targetInput = options.target?.trim() || process.cwd();
  const targetPath = resolveRepoRoot(targetInput);

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`Install target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const repoRoot = await resolveGitTopLevel(targetPath);
  const paths = resolveRepoPaths(repoRoot);
  const created: string[] = [];

  for (const directory of [
    path.dirname(paths.agentsFile),
    path.dirname(paths.environmentFile),
    path.dirname(paths.configFile),
    paths.scriptsDir,
    path.dirname(paths.goalFile),
    paths.locksDir,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }

  const lock = await acquireCycleLock(paths.cycleLockFile, {
    command: "codex-autonomy install",
  });

  try {
    const textFiles: Array<[string, string]> = [
      [paths.agentsFile, getAgentsMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-plan", "SKILL.md"), getAutonomyPlanSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-work", "SKILL.md"), getAutonomyWorkSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-intake", "SKILL.md"), getAutonomyIntakeSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-review", "SKILL.md"), getAutonomyReviewSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-report", "SKILL.md"), getAutonomyReportSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-sprint", "SKILL.md"), getAutonomySprintSkillMarkdown() + "\n"],
      [paths.environmentFile, getEnvironmentTomlTemplate() + "\n"],
      [paths.configFile, getConfigTomlTemplate() + "\n"],
      [paths.setupScript, getSetupWindowsScriptTemplate()],
      [paths.verifyScript, getInstallVerifyScriptTemplate()],
      [paths.smokeScript, getSmokeScriptTemplate()],
      [path.join(paths.scriptsDir, "review.ps1"), getReviewScriptTemplate()],
      [paths.goalFile, getInstallGoalMarkdown() + "\n"],
      [paths.journalFile, getDefaultJournalMarkdown() + "\n"],
    ];

    for (const [filePath, content] of textFiles) {
      if (await ensureTextFile(filePath, content)) {
        created.push(filePath);
      }
    }

    const jsonFiles: Array<[string, unknown]> = [
      [paths.tasksFile, DEFAULT_TASKS],
      [paths.goalsFile, createDefaultGoalsDocument()],
      [paths.proposalsFile, createDefaultProposalsDocument()],
      [paths.stateFile, createDefaultState()],
      [paths.settingsFile, createDefaultSettingsDocument()],
      [paths.resultsFile, createDefaultResultsDocument()],
      [paths.blockersFile, DEFAULT_BLOCKERS],
      [path.join(paths.schemaDir, "tasks.schema.json"), tasksSchema],
      [path.join(paths.schemaDir, "goals.schema.json"), goalsSchema],
      [path.join(paths.schemaDir, "proposals.schema.json"), proposalsSchema],
      [path.join(paths.schemaDir, "state.schema.json"), stateSchema],
      [path.join(paths.schemaDir, "settings.schema.json"), settingsSchema],
      [path.join(paths.schemaDir, "results.schema.json"), resultsSchema],
      [path.join(paths.schemaDir, "blockers.schema.json"), blockersSchema],
    ];

    for (const [filePath, value] of jsonFiles) {
      if (await ensureJsonFile(filePath, value)) {
        created.push(filePath);
      }
    }

  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }

  return {
    ok: true,
    message: created.length > 0 ? `Installed codex-autonomy into ${repoRoot}.` : `codex-autonomy was already present in ${repoRoot}.`,
    warnings: created.length > 0 ? [{ code: "created_files", message: `Created ${created.length} file(s).` }] : undefined,
  };
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .requiredOption("--target <path>", "Target repository root")
    .description("Install the codex-autonomy control surface into a target repository")
    .action(async (options: InstallOptions) => {
      const result = await runInstallCommand({ target: options.target });
      console.log(JSON.stringify(result, null, 2));
    });
}

async function ensureTextFile(filePath: string, content: string): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  await writeTextFileAtomic(filePath, content);
  return true;
}

async function ensureJsonFile(filePath: string, value: unknown): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  await writeJsonAtomic(filePath, value);
  return true;
}

async function resolveGitTopLevel(targetPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    return path.resolve(stdout.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Unable to resolve Git repository root from ${targetPath}: ${message}`, CLI_EXIT_CODES.validation);
  }
}
