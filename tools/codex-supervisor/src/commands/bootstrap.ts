import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import type { BlockersDocument, CommandResult, SlicesDocument, TasksDocument } from "../contracts/autonomy.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { appendJournalEntry } from "../infra/journal.js";
import {
  blockersSchema,
  decisionPolicySchema,
  goalsSchema,
  proposalsSchema,
  resultsSchema,
  settingsSchema,
  slicesSchema,
  stateSchema,
  tasksSchema,
  verificationSchema,
} from "../schemas/index.js";
import { resolveRepoPaths } from "../shared/paths.js";
import {
  getAgentsMarkdown,
  getAutonomyDecisionSkillMarkdown,
  getAutonomyIntakeSkillMarkdown,
  getAutonomyPlanSkillMarkdown,
  getAutonomyReportSkillMarkdown,
  getAutonomyReviewSkillMarkdown,
  getAutonomySprintSkillMarkdown,
  getAutonomyWorkSkillMarkdown,
  getConfigTomlTemplate,
  getDefaultJournalMarkdown,
  getEnvironmentTomlTemplate,
  getReadmeMarkdown,
  getReviewScriptTemplate,
  getSetupWindowsScriptTemplate,
  getSmokeScriptTemplate,
  getVerifyScriptTemplate,
} from "../scaffold/templates.js";
import {
  createDefaultGoalsDocument,
  createDefaultDecisionPolicy,
  createDefaultProposalsDocument,
  createDefaultResultsDocument,
  createDefaultSettingsDocument,
  createDefaultSlicesDocument,
  createDefaultState,
  createDefaultVerificationDocument,
  formatGoalMarkdown,
} from "./control-plane.js";

const DEFAULT_TASKS: TasksDocument = {
  version: 1,
  tasks: []
};

const DEFAULT_SLICES: SlicesDocument = createDefaultSlicesDocument();

const DEFAULT_BLOCKERS: BlockersDocument = {
  version: 1,
  blockers: []
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
  const intakeSkillFile = path.join(repoRoot, ".agents", "skills", "$autonomy-intake", "SKILL.md");
  const reviewSkillFile = path.join(repoRoot, ".agents", "skills", "$autonomy-review", "SKILL.md");
  const reportSkillFile = path.join(repoRoot, ".agents", "skills", "$autonomy-report", "SKILL.md");
  const sprintSkillFile = path.join(repoRoot, ".agents", "skills", "$autonomy-sprint", "SKILL.md");
  const decisionSkillFile = path.join(repoRoot, ".agents", "skills", "$autonomy-decision", "SKILL.md");
  const readmeFile = path.join(repoRoot, "README.md");
  const tasksSchemaFile = path.join(paths.schemaDir, "tasks.schema.json");
  const slicesSchemaFile = path.join(paths.schemaDir, "slices.schema.json");
  const goalsSchemaFile = path.join(paths.schemaDir, "goals.schema.json");
  const proposalsSchemaFile = path.join(paths.schemaDir, "proposals.schema.json");
  const stateSchemaFile = path.join(paths.schemaDir, "state.schema.json");
  const settingsSchemaFile = path.join(paths.schemaDir, "settings.schema.json");
  const resultsSchemaFile = path.join(paths.schemaDir, "results.schema.json");
  const blockersSchemaFile = path.join(paths.schemaDir, "blockers.schema.json");
  const verificationSchemaFile = path.join(paths.schemaDir, "verification.schema.json");
  const decisionPolicySchemaFile = path.join(paths.schemaDir, "decision-policy.schema.json");
  const cycleLockKeepFile = path.join(paths.locksDir, ".gitkeep");

  const repoDirectories = [
    paths.scriptsDir,
    paths.codexDir,
    path.dirname(paths.environmentFile),
    path.dirname(planSkillFile),
    path.dirname(workSkillFile),
    path.dirname(intakeSkillFile),
    path.dirname(reviewSkillFile),
    path.dirname(reportSkillFile),
    path.dirname(sprintSkillFile),
    path.dirname(decisionSkillFile),
  ];

  for (const directory of repoDirectories) {
    await fs.mkdir(directory, { recursive: true });
  }

  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-supervisor bootstrap");
  try {
    const now = new Date().toISOString();
    const autonomyDirectories = [
      paths.autonomyDir,
      paths.schemaDir,
      paths.locksDir,
    ];

    for (const directory of autonomyDirectories) {
      await fs.mkdir(directory, { recursive: true });
    }

    const textFileEntries: Array<[string, string]> = [
      [readmeFile, getReadmeMarkdown() + "\n"],
      [paths.agentsFile, getAgentsMarkdown() + "\n"],
      [planSkillFile, getAutonomyPlanSkillMarkdown() + "\n"],
      [workSkillFile, getAutonomyWorkSkillMarkdown() + "\n"],
      [intakeSkillFile, getAutonomyIntakeSkillMarkdown() + "\n"],
      [reviewSkillFile, getAutonomyReviewSkillMarkdown() + "\n"],
      [reportSkillFile, getAutonomyReportSkillMarkdown() + "\n"],
      [sprintSkillFile, getAutonomySprintSkillMarkdown() + "\n"],
      [decisionSkillFile, getAutonomyDecisionSkillMarkdown() + "\n"],
      [paths.goalFile, formatGoalMarkdown(null) + "\n"],
      [paths.journalFile, getDefaultJournalMarkdown() + "\n"],
      [paths.environmentFile, getEnvironmentTomlTemplate() + "\n"],
      [paths.configFile, getConfigTomlTemplate() + "\n"],
      [paths.setupScript, getSetupWindowsScriptTemplate()],
      [paths.verifyScript, getVerifyScriptTemplate()],
      [paths.smokeScript, getSmokeScriptTemplate()],
      [paths.reviewScript, getReviewScriptTemplate()],
      [cycleLockKeepFile, "\n"],
    ];

    for (const [filePath, content] of textFileEntries) {
      if (await ensureTextFile(filePath, content)) {
        created.push(filePath);
      }
    }

    const jsonFileEntries: Array<[string, unknown]> = [
      [paths.tasksFile, DEFAULT_TASKS],
      [paths.slicesFile, DEFAULT_SLICES],
      [paths.goalsFile, createDefaultGoalsDocument()],
      [paths.proposalsFile, createDefaultProposalsDocument()],
      [paths.stateFile, createDefaultState()],
      [paths.settingsFile, createDefaultSettingsDocument()],
      [paths.resultsFile, createDefaultResultsDocument()],
      [paths.verificationFile, createDefaultVerificationDocument()],
      [paths.decisionPolicyFile, createDefaultDecisionPolicy()],
      [paths.blockersFile, DEFAULT_BLOCKERS],
      [tasksSchemaFile, tasksSchema],
      [slicesSchemaFile, slicesSchema],
      [goalsSchemaFile, goalsSchema],
      [proposalsSchemaFile, proposalsSchema],
      [stateSchemaFile, stateSchema],
      [settingsSchemaFile, settingsSchema],
      [resultsSchemaFile, resultsSchema],
      [blockersSchemaFile, blockersSchema],
      [verificationSchemaFile, verificationSchema],
      [decisionPolicySchemaFile, decisionPolicySchema],
    ];

    for (const [filePath, value] of jsonFileEntries) {
      if (await ensureJsonFile(filePath, value)) {
        created.push(filePath);
      }
    }

    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId: "bootstrap",
      result: created.length > 0 ? "passed" : "noop",
      summary:
        created.length > 0
          ? `Bootstrap created ${created.length} missing file(s) or schema artifact(s).`
          : "Bootstrap found all expected control-plane files already present.",
      verify: "not run (codex-supervisor bootstrap)",
      blocker: "none",
    });
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
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
