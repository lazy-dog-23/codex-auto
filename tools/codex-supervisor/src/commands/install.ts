import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { detectCodexProcess as detectCodexProcessProbe, discoverPowerShellExecutable } from "../infra/process.js";
import { isDirectory, loadJsonFile, pathExists, writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoPaths, resolveRepoRoot } from "../shared/paths.js";
import {
  getOperatorThreadGuidance,
  inspectThreadBindingContext,
  type OperatorThreadAction,
  type ThreadBindingState,
} from "../shared/thread-context.js";
import {
  blockersSchema,
  goalsSchema,
  proposalsSchema,
  resultsSchema,
  settingsSchema,
  stateSchema,
  tasksSchema,
  verificationSchema,
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
  getInstallVerifyScriptTemplate,
  getReadmeManagedSectionMarkdown,
  getLegacyReviewScriptTemplates,
  getReviewScriptTemplate,
  getSetupWindowsScriptTemplate,
  getSmokeScriptTemplate,
  getDefaultJournalMarkdown,
} from "../scaffold/templates.js";
import {
  createDefaultInstallDocument,
  createDefaultGoalsDocument,
  createDefaultProposalsDocument,
  createDefaultResultsDocument,
  createDefaultSettingsDocument,
  createDefaultState,
  createDefaultVerificationDocument,
  formatGoalMarkdown,
  getActiveGoal,
  persistGoalMirror,
} from "./control-plane.js";
import type {
  AutonomyResults,
  AutonomySettings,
  AutonomyState,
  BlockersDocument,
  CommandWarning,
  GoalsDocument,
  ProposalsDocument,
  RunMode,
  TasksDocument,
} from "../contracts/autonomy.js";
import {
  getInstallMetadataPath,
  getManagedFileClass,
} from "../shared/paths.js";
import { PRODUCT_VERSION } from "../shared/product.js";
import {
  MANAGED_README_SECTION_END,
  MANAGED_README_SECTION_START,
  classifyManagedReadme,
  upsertManagedReadmeSection,
} from "../shared/managed-readme.js";

const execFileAsync = promisify(execFile);
const LEGACY_GOAL_ID = "goal-legacy";

const DEFAULT_TASKS: TasksDocument = {
  version: 1,
  tasks: [],
};

const DEFAULT_BLOCKERS: BlockersDocument = {
  version: 1,
  blockers: [],
};

interface ManagedControlSurfaceSpec {
  path: string;
  relative_path: string;
  template_id: string;
  management_class: "static_template" | "repo_customized" | "runtime_state";
  kind: "text" | "json";
  content: string;
  content_mode?: "full_file" | "markdown_section";
  section_start_marker?: string;
  section_end_marker?: string;
}

interface ManagedInstallFileRecord {
  path: string;
  template_id: string;
  installed_hash: string;
  last_reconciled_product_version: string;
  management_class: "static_template" | "repo_customized" | "runtime_state";
  baseline_origin?: "template" | "repo_specific";
  content_mode?: "full_file" | "markdown_section";
  section_start_marker?: string;
  section_end_marker?: string;
}

interface InstallMetadataDocument {
  version: number;
  product_version: string;
  installed_at: string;
  managed_paths: string[];
  source_repo: string;
  managed_files: ManagedInstallFileRecord[];
}

const LEGACY_RESULTS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/results.schema.json",
  title: "AutonomyResultsFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "planner", "worker", "review", "commit", "reporter"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    planner: {
      type: "object",
      additionalProperties: false,
      required: ["status", "goal_id", "summary"],
      properties: {
        status: {
          type: "string",
          enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
        },
        goal_id: {
          type: ["string", "null"],
          minLength: 1,
        },
        summary: {
          type: ["string", "null"],
        },
      },
    },
    worker: {
      type: "object",
      additionalProperties: false,
      required: ["status", "goal_id", "summary"],
      properties: {
        status: {
          type: "string",
          enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
        },
        goal_id: {
          type: ["string", "null"],
          minLength: 1,
        },
        summary: {
          type: ["string", "null"],
        },
      },
    },
    review: {
      type: "object",
      additionalProperties: false,
      required: ["status", "goal_id", "summary"],
      properties: {
        status: {
          type: "string",
          enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
        },
        goal_id: {
          type: ["string", "null"],
          minLength: 1,
        },
        summary: {
          type: ["string", "null"],
        },
      },
    },
    commit: {
      type: "object",
      additionalProperties: false,
      required: ["status", "goal_id", "summary"],
      properties: {
        status: {
          type: "string",
          enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
        },
        goal_id: {
          type: ["string", "null"],
          minLength: 1,
        },
        summary: {
          type: ["string", "null"],
        },
      },
    },
    reporter: {
      type: "object",
      additionalProperties: false,
      required: ["status", "goal_id", "summary"],
      properties: {
        status: {
          type: "string",
          enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
        },
        goal_id: {
          type: ["string", "null"],
          minLength: 1,
        },
        summary: {
          type: ["string", "null"],
        },
      },
    },
  },
} as const;

interface InstallOptions {
  target?: string;
}

interface InstallSummary {
  target_path: string;
  is_git_repo: boolean;
  automation_ready: boolean;
  codex_process_detected: boolean;
  background_worktree_prereqs: boolean;
  control_surface_files_created: number;
  install_metadata_path: string;
  install_metadata_written: boolean;
  preflight: {
    checked_paths: number;
    missing_paths: string[];
    managed_match_paths: string[];
    managed_diverged_paths: string[];
    foreign_occupied_paths: string[];
  };
  next_automations: Array<{
    name: string;
    purpose: string;
  }>;
  current_thread_id: string | null;
  current_thread_source: string | null;
  thread_binding_state: ThreadBindingState;
  thread_binding_hint: string | null;
  next_operator_action: OperatorThreadAction;
  next_operator_command: string | null;
  warning: string | null;
  private_automation_storage_untouched: boolean;
}

interface InstallResult {
  ok: boolean;
  message: string;
  summary: InstallSummary;
  warnings?: Array<{ code: string; message: string }>;
}

interface InstallPreflightSummary {
  checked_paths: number;
  missing_paths: string[];
  managed_match_paths: string[];
  managed_diverged_paths: string[];
  foreign_occupied_paths: string[];
}

interface InstallFileEntry {
  filePath: string;
  content: string;
}

interface InstallJsonEntry {
  filePath: string;
  value: unknown;
}

interface InstallDependencies {
  detectGitTopLevel?: (targetPath: string) => Promise<string | null>;
  detectCodexProcess?: () => Promise<boolean>;
}

export async function runInstallCommand(
  options: InstallOptions = {},
  dependencies: InstallDependencies = {},
): Promise<InstallResult> {
  const targetInput = options.target?.trim() || process.cwd();
  const targetPath = resolveRepoRoot(targetInput);

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`Install target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const repoRoot = (await (dependencies.detectGitTopLevel ?? resolveGitTopLevel)(targetPath)) ?? targetPath;
  const isGitRepo = repoRoot !== targetPath || (await pathExists(path.join(targetPath, ".git")));
  const paths = resolveRepoPaths(repoRoot);
  const installMetadataPath = getInstallMetadataPath(repoRoot);
  const requestedManagedSpecs = buildManagedControlSurfaceSpecs(paths);
  const { managedSpecs, warnings: managedSpecWarnings } = await resolveInstallManagedSpecs(requestedManagedSpecs);
  const installMetadataExpectation = createInstallMetadataExpectation(".", managedSpecs);
  const created: string[] = [];
  const textFiles = managedSpecs.filter((spec) => spec.kind === "text");
  const jsonFiles = managedSpecs.filter((spec) => spec.kind === "json").map((spec) => [spec.path, JSON.parse(spec.content)] as [string, unknown]);

  const installPreflight = await inspectInstallPreflight({
    textFiles,
    jsonFiles,
    installMetadataPath,
    installMetadataExpectation,
  });
  const preflightThreadBindingContext = await loadRepoThreadBindingContext(paths);
  const preflightOperatorGuidance = getOperatorThreadGuidance(preflightThreadBindingContext);

  if (installPreflight.foreign_occupied_paths.length > 0) {
    return {
      ok: false,
      message: `Install blocked by foreign-occupied path(s): ${installPreflight.foreign_occupied_paths.join(", ")}.`,
      summary: {
        target_path: repoRoot,
        is_git_repo: isGitRepo,
        automation_ready: false,
        codex_process_detected: false,
        background_worktree_prereqs: false,
        control_surface_files_created: 0,
        install_metadata_path: installMetadataPath,
        install_metadata_written: false,
        preflight: installPreflight,
        next_automations: buildNextAutomationSuggestions(isGitRepo),
        current_thread_id: preflightThreadBindingContext.currentThreadId,
        current_thread_source: preflightThreadBindingContext.currentThreadSource,
        thread_binding_state: preflightThreadBindingContext.bindingState,
        thread_binding_hint: preflightThreadBindingContext.bindingHint,
        next_operator_action: preflightOperatorGuidance.nextOperatorAction,
        next_operator_command: preflightOperatorGuidance.nextOperatorCommand,
        warning: `Install preflight found foreign-occupied path(s): ${installPreflight.foreign_occupied_paths.join(", ")}.`,
        private_automation_storage_untouched: true,
      },
      warnings: [
        {
          code: "foreign_occupied_paths",
          message: `Install preflight found foreign-occupied path(s): ${installPreflight.foreign_occupied_paths.join(", ")}.`,
        },
        ...managedSpecWarnings,
      ],
    };
  }

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
    for (const spec of textFiles) {
      if (await ensureTextFile(spec)) {
        created.push(spec.path);
      }
    }

    for (const [filePath, value] of jsonFiles) {
      if (await ensureJsonFile(filePath, value)) {
        created.push(filePath);
      }
    }

    const installMetadataWritten = await ensureInstallMetadataFile(installMetadataPath, installPreflight, installMetadataExpectation);

    const codexProcessDetected = await (dependencies.detectCodexProcess ?? detectCodexProcess)();
    const backgroundWorktreePrereqs = isGitRepo && (await hasBackgroundWorktreePrerequisites(paths, installMetadataPath));
    const automationReady = isGitRepo && backgroundWorktreePrereqs && codexProcessDetected;
    const threadBindingContext = await loadRepoThreadBindingContext(paths);
    const operatorGuidance = getOperatorThreadGuidance(threadBindingContext);
    const warning = !isGitRepo
      ? `Target ${repoRoot} is not a Git repository; install completed in detect-only mode.`
      : automationReady
        ? "Environment checks passed. Existing managed files were left untouched. Use codex-autonomy upgrade-managed for a guided reconcile plan."
        : codexProcessDetected
          ? "Background worktree prerequisites are not yet satisfied. Existing managed files were left untouched."
          : "Codex process was not detected, so automation is not ready yet. Existing managed files were left untouched.";

    const warnings = [
      !isGitRepo ? { code: "non_git_repo", message: `Target ${repoRoot} is not a Git repository.` } : null,
      !automationReady ? { code: "not_automation_ready", message: "Automation is not ready yet." } : null,
      !codexProcessDetected ? { code: "codex_process_not_detected", message: "Codex process was not detected." } : null,
      !backgroundWorktreePrereqs
        ? { code: "background_worktree_not_ready", message: "Background worktree prerequisites are not ready." }
        : null,
      installPreflight.managed_diverged_paths.length > 0
        ? {
            code: "managed_paths_diverged",
            message: `Preflight found existing managed file(s) that differ from the generated scaffold: ${installPreflight.managed_diverged_paths.join(", ")}.`,
          }
        : null,
      ...managedSpecWarnings,
    ].filter((value): value is { code: string; message: string } => value !== null);

    return {
      ok: true,
      message: buildInstallMessage(repoRoot, isGitRepo, automationReady, created.length, installPreflight, threadBindingContext, operatorGuidance),
      summary: {
        target_path: repoRoot,
        is_git_repo: isGitRepo,
        automation_ready: automationReady,
        codex_process_detected: codexProcessDetected,
        background_worktree_prereqs: backgroundWorktreePrereqs,
        control_surface_files_created: created.length,
        install_metadata_path: installMetadataPath,
        install_metadata_written: installMetadataWritten,
        preflight: installPreflight,
        next_automations: buildNextAutomationSuggestions(isGitRepo),
        current_thread_id: threadBindingContext.currentThreadId,
        current_thread_source: threadBindingContext.currentThreadSource,
        thread_binding_state: threadBindingContext.bindingState,
        thread_binding_hint: threadBindingContext.bindingHint,
        next_operator_action: operatorGuidance.nextOperatorAction,
        next_operator_command: operatorGuidance.nextOperatorCommand,
        warning,
        private_automation_storage_untouched: true,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };

  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
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

async function resolveInstallManagedSpecs(
  specs: ManagedControlSurfaceSpec[],
): Promise<{ managedSpecs: ManagedControlSurfaceSpec[]; warnings: CommandWarning[] }> {
  const managedSpecs: ManagedControlSurfaceSpec[] = [];
  const warnings: CommandWarning[] = [];

  for (const spec of specs) {
    if (!isMarkdownSectionManagedSpec(spec)) {
      managedSpecs.push(spec);
      continue;
    }

    try {
      const stats = await fs.lstat(spec.path);
      if (!stats.isFile()) {
        warnings.push({
          code: "readme_not_regular_file",
          message: "README.md is not a regular file, so codex-autonomy left it unmanaged.",
        });
        continue;
      }
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        managedSpecs.push(spec);
        continue;
      }
      throw error;
    }

    const existing = await fs.readFile(spec.path, "utf8");
    const classified = classifyManagedReadme(existing);
    if (classified.ok) {
      managedSpecs.push(spec);
      continue;
    }

    warnings.push({
      code: classified.reasonCode ?? "readme_unmanaged",
      message: classified.reasonMessage ?? "README.md is outside the managed section policy and was left unmanaged.",
    });
  }

  return { managedSpecs, warnings };
}

async function ensureTextFile(spec: ManagedControlSurfaceSpec): Promise<boolean> {
  if (!isMarkdownSectionManagedSpec(spec)) {
    if (await pathExists(spec.path)) {
      return false;
    }

    await writeTextFileAtomic(spec.path, spec.content);
    return true;
  }

  let existingContent: string | null = null;
  try {
    const stats = await fs.lstat(spec.path);
    if (!stats.isFile()) {
      throw new CliError("README.md is not a regular file and cannot be managed automatically.", CLI_EXIT_CODES.validation);
    }
    existingContent = await fs.readFile(spec.path, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const updated = upsertManagedReadmeSection(existingContent, spec.content);
  if (!updated.ok || typeof updated.content !== "string") {
    throw new CliError(
      updated.reasonMessage ?? "README.md cannot be managed as a bounded codex-autonomy section.",
      CLI_EXIT_CODES.validation,
    );
  }

  if (existingContent !== null && updated.mode === "no_change") {
    return false;
  }

  await writeTextFileAtomic(spec.path, updated.content);
  return existingContent === null;
}

async function ensureJsonFile(filePath: string, value: unknown): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  await writeJsonAtomic(filePath, value);
  return true;
}

async function inspectInstallPreflight(options: {
  textFiles: ReadonlyArray<ManagedControlSurfaceSpec>;
  jsonFiles: ReadonlyArray<InstallJsonEntry | [string, unknown]>;
  installMetadataPath: string;
  installMetadataExpectation: InstallMetadataDocument;
}): Promise<InstallPreflightSummary> {
  const textEntries = options.textFiles.map((spec) => ({
    filePath: spec.path,
    content: spec.content,
    spec,
  }));
  const jsonEntries = options.jsonFiles.map(normalizeJsonEntry);
  const managedMatchPaths = new Set<string>();
  const missingPaths = new Set<string>();
  const managedDivergedPaths = new Set<string>();
  const foreignOccupiedPaths = new Set<string>();

  for (const entry of [...textEntries, ...jsonEntries]) {
    const existingState = await inspectTargetFileState(
      entry.filePath,
      entry.content,
      (entry as { spec?: ManagedControlSurfaceSpec }).spec,
    );
    if (existingState === "managed_match") {
      managedMatchPaths.add(entry.filePath);
    } else if (existingState === "missing") {
      missingPaths.add(entry.filePath);
    } else if (existingState === "managed_diverged") {
      managedDivergedPaths.add(entry.filePath);
    } else if (existingState === "foreign_occupied") {
      foreignOccupiedPaths.add(entry.filePath);
    }
  }

  const installMetadataState = await inspectInstallMetadataState(
    options.installMetadataPath,
    options.installMetadataExpectation,
  );
  if (installMetadataState === "managed_match") {
    managedMatchPaths.add(options.installMetadataPath);
  } else if (installMetadataState === "missing") {
    missingPaths.add(options.installMetadataPath);
  } else if (installMetadataState === "managed_diverged") {
    managedDivergedPaths.add(options.installMetadataPath);
  } else if (installMetadataState === "foreign_occupied") {
    foreignOccupiedPaths.add(options.installMetadataPath);
  }

  return {
    checked_paths: textEntries.length + jsonEntries.length + 1,
    missing_paths: [...missingPaths],
    managed_match_paths: [...managedMatchPaths],
    managed_diverged_paths: [...managedDivergedPaths],
    foreign_occupied_paths: [...foreignOccupiedPaths],
  };
}

async function ensureInstallMetadataFile(
  filePath: string,
  preflight: InstallPreflightSummary,
  expectation: InstallMetadataDocument,
): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  const metadata = {
    ...expectation,
    installed_at: new Date().toISOString(),
    preflight: {
      checked_paths: preflight.checked_paths,
      missing_paths: preflight.missing_paths,
      managed_match_paths: preflight.managed_match_paths,
      managed_diverged_paths: preflight.managed_diverged_paths,
      foreign_occupied_paths: preflight.foreign_occupied_paths,
    },
  };

  await writeJsonAtomic(filePath, metadata);
  return true;
}

async function loadRepoThreadBindingContext(paths: ReturnType<typeof resolveRepoPaths>) {
  if (!(await pathExists(paths.stateFile))) {
    return inspectThreadBindingContext(null);
  }

  try {
    const state = await loadJsonFile<unknown>(paths.stateFile);
    if (state && typeof state === "object" && !Array.isArray(state)) {
      const reportThreadId = typeof (state as Record<string, unknown>).report_thread_id === "string"
        ? (state as Record<string, string>).report_thread_id
        : null;
      return inspectThreadBindingContext(reportThreadId);
    }
  } catch {
    // Fall through to the default thread-context view when the state file is unreadable.
  }

  return inspectThreadBindingContext(null);
}

function normalizeJsonEntry(entry: InstallJsonEntry | [string, unknown]): InstallFileEntry {
  if (Array.isArray(entry)) {
    return {
      filePath: entry[0],
      content: `${JSON.stringify(entry[1], null, 2)}\n`,
    };
  }

  return {
    filePath: entry.filePath,
    content: `${JSON.stringify(entry.value, null, 2)}\n`,
  };
}

async function inspectTargetFileState(
  filePath: string,
  desiredContent: string,
  spec?: ManagedControlSurfaceSpec,
): Promise<"managed_match" | "missing" | "managed_diverged" | "foreign_occupied"> {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile()) {
      return "foreign_occupied";
    }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }

  const existing = await fs.readFile(filePath, "utf8");
  if (spec && isMarkdownSectionManagedSpec(spec)) {
    const updated = upsertManagedReadmeSection(existing, desiredContent);
    if (!updated.ok) {
      return "managed_diverged";
    }
    return updated.mode === "no_change" ? "managed_match" : "managed_diverged";
  }

  return existing === desiredContent ? "managed_match" : "managed_diverged";
}

async function inspectInstallMetadataState(
  filePath: string,
  expectation: InstallMetadataDocument,
): Promise<"managed_match" | "missing" | "managed_diverged" | "foreign_occupied"> {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile()) {
      return "foreign_occupied";
    }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }

  let existing: unknown;
  try {
    existing = await loadJsonFile(filePath);
  } catch {
    return "managed_diverged";
  }

  return matchesManagedInstallMetadata(existing, expectation) ? "managed_match" : "managed_diverged";
}

function matchesManagedInstallMetadata(
  value: unknown,
  expectation: InstallMetadataDocument,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (record.version !== expectation.version) {
    return false;
  }

  if (typeof record.product_version !== "string" || record.product_version.length === 0) {
    return false;
  }

  if (typeof record.installed_at !== "string" || record.installed_at.length === 0) {
    return false;
  }

  if (record.source_repo !== expectation.source_repo) {
    return false;
  }

  if (!Array.isArray(record.managed_paths)) {
    return false;
  }

  const existingManagedPaths = record.managed_paths
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.replace(/\\/g, "/"))
    .sort();
  const expectedManagedPaths = [...expectation.managed_paths]
    .map((item) => item.replace(/\\/g, "/"))
    .sort();

  if (existingManagedPaths.length !== expectedManagedPaths.length) {
    return false;
  }

  if (!Array.isArray(record.managed_files)) {
    return false;
  }

  const existingManagedFiles = record.managed_files
    .filter((item): item is ManagedInstallFileRecord => isManagedInstallFileRecord(item))
    .map((item) => normalizeManagedInstallFileRecord(item))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expectedManagedFiles = expectation.managed_files
    .map((item) => normalizeManagedInstallFileRecord(item))
    .sort((left, right) => left.path.localeCompare(right.path));

  if (existingManagedFiles.length !== expectedManagedFiles.length) {
    return false;
  }

  return existingManagedPaths.every((pathValue, index) => pathValue === expectedManagedPaths[index]) &&
    existingManagedFiles.every((entry, index) => {
      const expected = expectedManagedFiles[index];
      if (!expected) {
        return false;
      }
      return entry.path === expected.path
        && entry.template_id === expected.template_id
        && entry.installed_hash === expected.installed_hash
        && entry.last_reconciled_product_version === expected.last_reconciled_product_version
        && entry.management_class === expected.management_class
        && (entry.baseline_origin ?? "template") === (expected.baseline_origin ?? "template")
        && (entry.content_mode ?? "full_file") === (expected.content_mode ?? "full_file")
        && (entry.section_start_marker ?? null) === (expected.section_start_marker ?? null)
        && (entry.section_end_marker ?? null) === (expected.section_end_marker ?? null);
    });
}

function createInstallMetadataExpectation(sourceRepo: string, managedFiles: ManagedControlSurfaceSpec[]): InstallMetadataDocument {
  const managedPaths = Array.from(new Set([
    "autonomy/install.json",
    ...managedFiles.map((spec) => spec.relative_path),
  ])).sort();

  return {
    version: 1,
    product_version: PRODUCT_VERSION,
    installed_at: "1970-01-01T00:00:00.000Z",
    source_repo: sourceRepo,
    managed_paths: managedPaths,
    managed_files: buildManagedInstallFileRecords(managedFiles),
  };
}

function buildManagedControlSurfaceSpecs(paths: ReturnType<typeof resolveRepoPaths>): ManagedControlSurfaceSpec[] {
  const specs: Array<Omit<ManagedControlSurfaceSpec, "management_class">> = [
    {
      path: paths.agentsFile,
      relative_path: "AGENTS.md",
      template_id: "agents_markdown",
      kind: "text",
      content: `${getAgentsMarkdown()}\n`,
    },
    {
      path: paths.readmeFile,
      relative_path: "README.md",
      template_id: "readme_markdown_section",
      kind: "text",
      content: getReadmeManagedSectionMarkdown(),
      content_mode: "markdown_section",
      section_start_marker: MANAGED_README_SECTION_START,
      section_end_marker: MANAGED_README_SECTION_END,
    },
    {
      path: path.join(paths.repoRoot, ".agents", "skills", "$autonomy-plan", "SKILL.md"),
      relative_path: ".agents/skills/$autonomy-plan/SKILL.md",
      template_id: "autonomy_plan_skill_markdown",
      kind: "text",
      content: `${getAutonomyPlanSkillMarkdown()}\n`,
    },
    {
      path: path.join(paths.repoRoot, ".agents", "skills", "$autonomy-work", "SKILL.md"),
      relative_path: ".agents/skills/$autonomy-work/SKILL.md",
      template_id: "autonomy_work_skill_markdown",
      kind: "text",
      content: `${getAutonomyWorkSkillMarkdown()}\n`,
    },
    {
      path: path.join(paths.repoRoot, ".agents", "skills", "$autonomy-intake", "SKILL.md"),
      relative_path: ".agents/skills/$autonomy-intake/SKILL.md",
      template_id: "autonomy_intake_skill_markdown",
      kind: "text",
      content: `${getAutonomyIntakeSkillMarkdown()}\n`,
    },
    {
      path: path.join(paths.repoRoot, ".agents", "skills", "$autonomy-review", "SKILL.md"),
      relative_path: ".agents/skills/$autonomy-review/SKILL.md",
      template_id: "autonomy_review_skill_markdown",
      kind: "text",
      content: `${getAutonomyReviewSkillMarkdown()}\n`,
    },
    {
      path: path.join(paths.repoRoot, ".agents", "skills", "$autonomy-report", "SKILL.md"),
      relative_path: ".agents/skills/$autonomy-report/SKILL.md",
      template_id: "autonomy_report_skill_markdown",
      kind: "text",
      content: `${getAutonomyReportSkillMarkdown()}\n`,
    },
    {
      path: path.join(paths.repoRoot, ".agents", "skills", "$autonomy-sprint", "SKILL.md"),
      relative_path: ".agents/skills/$autonomy-sprint/SKILL.md",
      template_id: "autonomy_sprint_skill_markdown",
      kind: "text",
      content: `${getAutonomySprintSkillMarkdown()}\n`,
    },
    {
      path: paths.environmentFile,
      relative_path: ".codex/environments/environment.toml",
      template_id: "environment_toml",
      kind: "text",
      content: `${getEnvironmentTomlTemplate()}\n`,
    },
    {
      path: paths.configFile,
      relative_path: ".codex/config.toml",
      template_id: "config_toml",
      kind: "text",
      content: `${getConfigTomlTemplate()}\n`,
    },
    {
      path: paths.setupScript,
      relative_path: "scripts/setup.windows.ps1",
      template_id: "setup_windows_ps1",
      kind: "text",
      content: getSetupWindowsScriptTemplate(),
    },
    {
      path: paths.verifyScript,
      relative_path: "scripts/verify.ps1",
      template_id: "verify_ps1",
      kind: "text",
      content: getInstallVerifyScriptTemplate(),
    },
    {
      path: paths.smokeScript,
      relative_path: "scripts/smoke.ps1",
      template_id: "smoke_ps1",
      kind: "text",
      content: getSmokeScriptTemplate(),
    },
    {
      path: path.join(paths.scriptsDir, "review.ps1"),
      relative_path: "scripts/review.ps1",
      template_id: "review_ps1",
      kind: "text",
      content: getReviewScriptTemplate(),
    },
    {
      path: paths.goalFile,
      relative_path: "autonomy/goal.md",
      template_id: "goal_markdown",
      kind: "text",
      content: `${formatGoalMarkdown(null)}\n`,
    },
    {
      path: paths.journalFile,
      relative_path: "autonomy/journal.md",
      template_id: "journal_markdown",
      kind: "text",
      content: `${getDefaultJournalMarkdown()}\n`,
    },
    {
      path: paths.tasksFile,
      relative_path: "autonomy/tasks.json",
      template_id: "tasks_json",
      kind: "json",
      content: `${JSON.stringify(DEFAULT_TASKS, null, 2)}\n`,
    },
    {
      path: paths.goalsFile,
      relative_path: "autonomy/goals.json",
      template_id: "goals_json",
      kind: "json",
      content: `${JSON.stringify(createDefaultGoalsDocument(), null, 2)}\n`,
    },
    {
      path: paths.proposalsFile,
      relative_path: "autonomy/proposals.json",
      template_id: "proposals_json",
      kind: "json",
      content: `${JSON.stringify(createDefaultProposalsDocument(), null, 2)}\n`,
    },
    {
      path: paths.stateFile,
      relative_path: "autonomy/state.json",
      template_id: "state_json",
      kind: "json",
      content: `${JSON.stringify(createDefaultState(), null, 2)}\n`,
    },
    {
      path: paths.settingsFile,
      relative_path: "autonomy/settings.json",
      template_id: "settings_json",
      kind: "json",
      content: `${JSON.stringify(createDefaultSettingsDocument(), null, 2)}\n`,
    },
    {
      path: paths.resultsFile,
      relative_path: "autonomy/results.json",
      template_id: "results_json",
      kind: "json",
      content: `${JSON.stringify(createDefaultResultsDocument(), null, 2)}\n`,
    },
    {
      path: paths.verificationFile,
      relative_path: "autonomy/verification.json",
      template_id: "verification_json",
      kind: "json",
      content: `${JSON.stringify(createDefaultVerificationDocument(), null, 2)}\n`,
    },
    {
      path: paths.blockersFile,
      relative_path: "autonomy/blockers.json",
      template_id: "blockers_json",
      kind: "json",
      content: `${JSON.stringify(DEFAULT_BLOCKERS, null, 2)}\n`,
    },
    {
      path: path.join(paths.schemaDir, "tasks.schema.json"),
      relative_path: "autonomy/schema/tasks.schema.json",
      template_id: "tasks_schema_json",
      kind: "json",
      content: `${JSON.stringify(tasksSchema, null, 2)}\n`,
    },
    {
      path: path.join(paths.schemaDir, "goals.schema.json"),
      relative_path: "autonomy/schema/goals.schema.json",
      template_id: "goals_schema_json",
      kind: "json",
      content: `${JSON.stringify(goalsSchema, null, 2)}\n`,
    },
    {
      path: path.join(paths.schemaDir, "proposals.schema.json"),
      relative_path: "autonomy/schema/proposals.schema.json",
      template_id: "proposals_schema_json",
      kind: "json",
      content: `${JSON.stringify(proposalsSchema, null, 2)}\n`,
    },
    {
      path: path.join(paths.schemaDir, "state.schema.json"),
      relative_path: "autonomy/schema/state.schema.json",
      template_id: "state_schema_json",
      kind: "json",
      content: `${JSON.stringify(stateSchema, null, 2)}\n`,
    },
    {
      path: path.join(paths.schemaDir, "settings.schema.json"),
      relative_path: "autonomy/schema/settings.schema.json",
      template_id: "settings_schema_json",
      kind: "json",
      content: `${JSON.stringify(settingsSchema, null, 2)}\n`,
    },
    {
      path: path.join(paths.schemaDir, "results.schema.json"),
      relative_path: "autonomy/schema/results.schema.json",
      template_id: "results_schema_json",
      kind: "json",
      content: `${JSON.stringify(resultsSchema, null, 2)}\n`,
    },
    {
      path: path.join(paths.schemaDir, "blockers.schema.json"),
      relative_path: "autonomy/schema/blockers.schema.json",
      template_id: "blockers_schema_json",
      kind: "json",
      content: `${JSON.stringify(blockersSchema, null, 2)}\n`,
    },
    {
      path: path.join(paths.schemaDir, "verification.schema.json"),
      relative_path: "autonomy/schema/verification.schema.json",
      template_id: "verification_schema_json",
      kind: "json",
      content: `${JSON.stringify(verificationSchema, null, 2)}\n`,
    },
  ];

  return specs.map((spec) => ({
    ...spec,
    management_class: getManagedFileClass(spec.relative_path),
  }));
}

function buildManagedInstallFileRecords(specs: ManagedControlSurfaceSpec[]): ManagedInstallFileRecord[] {
  return specs.map((spec) => ({
    path: spec.relative_path,
    template_id: spec.template_id,
    installed_hash: getManagedSpecHash(spec, spec.content),
    last_reconciled_product_version: PRODUCT_VERSION,
    management_class: spec.management_class,
    baseline_origin: "template",
    content_mode: spec.content_mode,
    section_start_marker: spec.section_start_marker,
    section_end_marker: spec.section_end_marker,
  }));
}

function normalizeManagedInstallFileRecord(value: ManagedInstallFileRecord): ManagedInstallFileRecord {
  return {
    path: value.path.replace(/\\/g, "/"),
    template_id: value.template_id,
    installed_hash: value.installed_hash,
    last_reconciled_product_version: value.last_reconciled_product_version,
    management_class: value.management_class ?? getManagedFileClass(value.path),
    baseline_origin: value.baseline_origin === "repo_specific" ? "repo_specific" : "template",
    content_mode: value.content_mode === "markdown_section" ? "markdown_section" : "full_file",
    section_start_marker: typeof value.section_start_marker === "string" ? value.section_start_marker : undefined,
    section_end_marker: typeof value.section_end_marker === "string" ? value.section_end_marker : undefined,
  };
}

function isManagedInstallFileRecord(value: unknown): value is ManagedInstallFileRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.path === "string"
    && record.path.trim().length > 0
    && typeof record.template_id === "string"
    && record.template_id.trim().length > 0
    && typeof record.installed_hash === "string"
    && record.installed_hash.trim().length > 0
    && typeof record.last_reconciled_product_version === "string"
    && record.last_reconciled_product_version.trim().length > 0;
}

function isMarkdownSectionManagedSpec(spec: ManagedControlSurfaceSpec): boolean {
  return spec.kind === "text" && spec.content_mode === "markdown_section";
}

function getManagedSpecHash(spec: ManagedControlSurfaceSpec, content: string): string {
  if (!isMarkdownSectionManagedSpec(spec)) {
    return hashContent(content);
  }

  return hashContent(content.replace(/\r\n/g, "\n").trimEnd());
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function normalizeInstalledControlPlane(paths: ReturnType<typeof resolveRepoPaths>): Promise<{
  migratedFiles: number;
  placeholderGoalIds: string[];
}> {
  const now = new Date().toISOString();
  const rawState = await loadExistingJson(paths.stateFile, createDefaultState);
  let state = normalizeStateDocument(rawState);
  const rawSettings = await loadExistingJson(paths.settingsFile, createDefaultSettingsDocument);
  const settings = normalizeSettingsDocument(rawSettings);
  const rawResults = await loadExistingJson(paths.resultsFile, createDefaultResultsDocument);
  const results = normalizeResultsDocument(rawResults);
  const rawGoals = await loadExistingJson(paths.goalsFile, createDefaultGoalsDocument);
  let goalsNormalization = normalizeGoalsDocument(rawGoals, {
    referencedGoalIds: state.current_goal_id ? [state.current_goal_id] : [],
    activeGoalId: state.current_goal_id,
    defaultRunMode: state.run_mode,
    now,
  });
  let goals = goalsNormalization.document;
  let placeholderGoalIds = [...goalsNormalization.placeholderGoalIds];
  const fallbackGoalId = state.current_goal_id ?? goals.goals[0]?.id ?? LEGACY_GOAL_ID;
  const rawTasks = await loadExistingJson(paths.tasksFile, () => DEFAULT_TASKS);
  const tasks = normalizeTasksDocument(rawTasks, { fallbackGoalId, now });
  const rawProposals = await loadExistingJson(paths.proposalsFile, createDefaultProposalsDocument);
  const proposals = normalizeProposalsDocument(rawProposals, {
    fallbackGoalId: state.current_goal_id ?? tasks.tasks[0]?.goal_id ?? goals.goals[0]?.id ?? LEGACY_GOAL_ID,
    now,
  });
  goalsNormalization = normalizeGoalsDocument(goals, {
    referencedGoalIds: [
      ...tasks.tasks.map((task) => task.goal_id),
      ...proposals.proposals.map((proposal) => proposal.goal_id),
      ...(state.current_goal_id ? [state.current_goal_id] : []),
    ],
    activeGoalId: state.current_goal_id,
    defaultRunMode: state.run_mode,
    now,
  });
  goals = goalsNormalization.document;
  placeholderGoalIds = Array.from(new Set([...placeholderGoalIds, ...goalsNormalization.placeholderGoalIds]));
  const rawBlockers = await loadExistingJson(paths.blockersFile, () => DEFAULT_BLOCKERS);
  const normalizedBlockers = normalizeBlockersDocument(rawBlockers, { now });
  const placeholderProtection = protectPlaceholderGoalReferences({
    tasks,
    blockers: normalizedBlockers,
    placeholderGoalIds,
    currentTaskId: state.current_task_id,
    now,
  });
  const protectedTasks = placeholderProtection.tasks;
  const blockers = placeholderProtection.blockers;
  const openBlockerCount = blockers.blockers.filter((blocker) => blocker.status === "open").length;

  if (state.current_goal_id && placeholderGoalIds.includes(state.current_goal_id)) {
    state = {
      ...state,
      current_goal_id: null,
      current_task_id: null,
      cycle_status: "blocked",
      run_mode: null,
      last_result: "blocked",
      needs_human_review: true,
      sprint_active: false,
    };
  }

  if (placeholderGoalIds.length > 0) {
    state = {
      ...state,
      cycle_status: "blocked",
      last_result: "blocked",
      needs_human_review: true,
      sprint_active: false,
      open_blocker_count: openBlockerCount,
    };
  } else if (state.open_blocker_count !== openBlockerCount) {
    state = {
      ...state,
      open_blocker_count: openBlockerCount,
    };
  }

  const activeGoal = goals.goals.find((goal) => goal.status === "active") ?? null;
  if (!state.current_goal_id && activeGoal) {
    state = {
      ...state,
      current_goal_id: activeGoal.id,
      run_mode: activeGoal.run_mode,
    };
  }

  const writes = await Promise.all([
    writeNormalizedJsonIfChanged(paths.stateFile, rawState, state),
    writeNormalizedJsonIfChanged(paths.settingsFile, rawSettings, settings),
    writeNormalizedJsonIfChanged(paths.resultsFile, rawResults, results),
    writeNormalizedJsonIfChanged(paths.goalsFile, rawGoals, goals),
    writeNormalizedJsonIfChanged(paths.tasksFile, rawTasks, protectedTasks),
    writeNormalizedJsonIfChanged(paths.proposalsFile, rawProposals, proposals),
    writeNormalizedJsonIfChanged(paths.blockersFile, rawBlockers, blockers),
  ]);
  const migratedSchemaFiles = await migrateGeneratedSchemaFiles(paths);
  const migratedReviewScript = await maybeMigrateGeneratedTextFile(
    paths.reviewScript,
    getLegacyReviewScriptTemplates(),
    getReviewScriptTemplate(),
  );

  return {
    migratedFiles: writes.filter(Boolean).length + migratedSchemaFiles + (migratedReviewScript ? 1 : 0),
    placeholderGoalIds,
  };
}

async function loadExistingJson<T>(filePath: string, fallback: () => T): Promise<unknown> {
  if (!(await pathExists(filePath))) {
    return fallback();
  }

  return loadJsonFile<unknown>(filePath);
}

async function writeNormalizedJsonIfChanged(filePath: string, existing: unknown, normalized: unknown): Promise<boolean> {
  if (JSON.stringify(existing) === JSON.stringify(normalized)) {
    return false;
  }

  await writeJsonAtomic(filePath, normalized);
  return true;
}

async function migrateGeneratedSchemaFiles(paths: ReturnType<typeof resolveRepoPaths>): Promise<number> {
  const generatedSchemas: Array<{
    filePath: string;
    current: unknown;
    legacyVariants?: unknown[];
  }> = [
    { filePath: path.join(paths.schemaDir, "tasks.schema.json"), current: tasksSchema },
    { filePath: path.join(paths.schemaDir, "goals.schema.json"), current: goalsSchema },
    { filePath: path.join(paths.schemaDir, "proposals.schema.json"), current: proposalsSchema },
    { filePath: path.join(paths.schemaDir, "state.schema.json"), current: stateSchema },
    { filePath: path.join(paths.schemaDir, "settings.schema.json"), current: settingsSchema },
    {
      filePath: path.join(paths.schemaDir, "results.schema.json"),
      current: resultsSchema,
      legacyVariants: [LEGACY_RESULTS_SCHEMA],
    },
    { filePath: path.join(paths.schemaDir, "blockers.schema.json"), current: blockersSchema },
  ];
  const writes = await Promise.all(
    generatedSchemas.map((schema) => maybeMigrateGeneratedJsonFile(schema.filePath, schema.current, schema.legacyVariants ?? [])),
  );
  return writes.filter(Boolean).length;
}

async function maybeMigrateGeneratedJsonFile(filePath: string, normalized: unknown, legacyVariants: readonly unknown[]): Promise<boolean> {
  if (!(await pathExists(filePath))) {
    return false;
  }

  let existing: unknown;
  try {
    existing = await loadJsonFile<unknown>(filePath);
  } catch {
    return false;
  }

  if (JSON.stringify(existing) === JSON.stringify(normalized)) {
    return false;
  }

  const matchesKnownManagedVersion = legacyVariants
    .some((legacyVariant) => JSON.stringify(existing) === JSON.stringify(legacyVariant));
  if (!matchesKnownManagedVersion) {
    return false;
  }

  await writeJsonAtomic(filePath, normalized);
  return true;
}

async function maybeMigrateGeneratedTextFile(filePath: string, legacyTemplates: string[], currentTemplate: string): Promise<boolean> {
  if (!(await pathExists(filePath))) {
    return false;
  }

  const existing = await fs.readFile(filePath, "utf8");
  const normalizedExisting = normalizeTemplateText(existing);
  const normalizedCurrent = normalizeTemplateText(currentTemplate);
  if (normalizedExisting === normalizedCurrent) {
    return false;
  }

  const matchesLegacyTemplate = legacyTemplates
    .map((template) => normalizeTemplateText(template))
    .includes(normalizedExisting);
  if (!matchesLegacyTemplate) {
    return false;
  }

  await writeTextFileAtomic(filePath, currentTemplate);
  return true;
}

function normalizeTemplateText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function normalizeStateDocument(document: unknown): AutonomyState {
  const defaults = createDefaultState();
  const merged = mergeMissingFields(document, defaults) as Record<string, unknown>;
  return {
    version: 1,
    current_goal_id: readOptionalString(merged.current_goal_id),
    current_task_id: readOptionalString(merged.current_task_id),
    cycle_status: isOneOf(merged.cycle_status, ["idle", "planning", "working", "blocked", "review_pending"]) ? merged.cycle_status : defaults.cycle_status,
    run_mode: isOneOf(merged.run_mode, ["sprint", "cruise"]) ? merged.run_mode : null,
    last_planner_run_at: normalizeOptionalTimestamp(merged.last_planner_run_at),
    last_worker_run_at: normalizeOptionalTimestamp(merged.last_worker_run_at),
    last_result: isOneOf(merged.last_result, ["noop", "planned", "passed", "failed", "blocked"]) ? merged.last_result : defaults.last_result,
    consecutive_worker_failures: normalizeInteger(merged.consecutive_worker_failures, defaults.consecutive_worker_failures),
    needs_human_review: Boolean(merged.needs_human_review),
    open_blocker_count: normalizeInteger(merged.open_blocker_count, defaults.open_blocker_count),
    report_thread_id: readOptionalString(merged.report_thread_id),
    autonomy_branch: readNonEmptyString(merged.autonomy_branch, defaults.autonomy_branch),
    sprint_active: Boolean(merged.sprint_active),
    paused: Boolean(merged.paused),
    pause_reason: readOptionalString(merged.pause_reason),
    last_thread_summary_sent_at: normalizeOptionalTimestamp(merged.last_thread_summary_sent_at),
    last_inbox_run_at: normalizeOptionalTimestamp(merged.last_inbox_run_at),
  };
}

function normalizeSettingsDocument(document: unknown): AutonomySettings {
  const defaults = createDefaultSettingsDocument();
  const merged = mergeMissingFields(document, defaults) as Record<string, unknown>;
  const cadence = isPlainObject(merged.default_cruise_cadence) ? merged.default_cruise_cadence : defaults.default_cruise_cadence;
  return {
    version: 1,
    install_source: isOneOf(merged.install_source, ["local_package"]) ? merged.install_source : defaults.install_source,
    initial_confirmation_required: merged.initial_confirmation_required !== false,
    report_surface: isOneOf(merged.report_surface, ["thread_and_inbox"]) ? merged.report_surface : defaults.report_surface,
    auto_commit: isOneOf(merged.auto_commit, ["disabled", "autonomy_branch"]) ? merged.auto_commit : defaults.auto_commit,
    autonomy_branch: readNonEmptyString(merged.autonomy_branch, defaults.autonomy_branch),
    auto_continue_within_goal: merged.auto_continue_within_goal !== false,
    block_on_major_decision: merged.block_on_major_decision !== false,
    default_cruise_cadence: {
      planner_hours: normalizeInteger(cadence.planner_hours, defaults.default_cruise_cadence.planner_hours),
      worker_hours: normalizeInteger(cadence.worker_hours, defaults.default_cruise_cadence.worker_hours),
      reviewer_hours: normalizeInteger(cadence.reviewer_hours, defaults.default_cruise_cadence.reviewer_hours),
    },
    default_sprint_heartbeat_minutes: normalizeInteger(merged.default_sprint_heartbeat_minutes, defaults.default_sprint_heartbeat_minutes),
  };
}

function normalizeResultsDocument(document: unknown): AutonomyResults {
  const defaults = createDefaultResultsDocument();
  const merged = mergeMissingFields(document, defaults) as Record<string, unknown>;
  return {
    version: 1,
    last_thread_summary_sent_at: normalizeOptionalTimestamp(merged.last_thread_summary_sent_at),
    last_inbox_run_at: normalizeOptionalTimestamp(merged.last_inbox_run_at),
    last_summary_kind: isOneOf(merged.last_summary_kind, ["normal_success", "thread_summary", "immediate_exception", "goal_transition"])
      ? merged.last_summary_kind
      : null,
    last_summary_reason: readOptionalString(merged.last_summary_reason),
    latest_goal_transition: normalizeGoalTransitionSnapshot(merged.latest_goal_transition),
    planner: normalizeResultEntry(merged.planner),
    worker: normalizeResultEntry(merged.worker),
    review: normalizeResultEntry(merged.review),
    commit: normalizeResultEntry(merged.commit),
    reporter: normalizeResultEntry(merged.reporter),
  };
}

function normalizeGoalsDocument(
  document: unknown,
  options: {
    referencedGoalIds: string[];
    activeGoalId: string | null;
    defaultRunMode: RunMode | null;
    now: string;
  },
): {
  document: GoalsDocument;
  placeholderGoalIds: string[];
} {
  const input = isPlainObject(document) ? document : {};
  const goals = Array.isArray(input.goals) ? input.goals : [];
  const normalizedGoals = goals.map((goal, index) => normalizeGoalRecord(goal, {
    index,
    now: options.now,
    activeGoalId: options.activeGoalId,
    defaultRunMode: options.defaultRunMode ?? "cruise",
  }));
  const existingIds = new Set(normalizedGoals.map((goal) => goal.id));
  const placeholderGoalIds: string[] = [];

  for (const goalId of options.referencedGoalIds) {
    if (!goalId || existingIds.has(goalId)) {
      continue;
    }

    normalizedGoals.push(createPlaceholderGoal(goalId, {
      now: options.now,
      runMode: options.defaultRunMode ?? "cruise",
    }));
    existingIds.add(goalId);
    placeholderGoalIds.push(goalId);
  }

  return {
    document: {
      version: 1,
      goals: normalizedGoals,
    },
    placeholderGoalIds,
  };
}

function normalizeTasksDocument(
  document: unknown,
  options: {
    fallbackGoalId: string;
    now: string;
  },
): TasksDocument {
  const input = isPlainObject(document) ? document : {};
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  return {
    version: 1,
    tasks: tasks.map((task, index) => normalizeTaskRecord(task, {
      index,
      fallbackGoalId: options.fallbackGoalId,
      now: options.now,
    })),
  };
}

function normalizeProposalsDocument(
  document: unknown,
  options: {
    fallbackGoalId: string;
    now: string;
  },
): ProposalsDocument {
  const input = isPlainObject(document) ? document : {};
  const proposals = Array.isArray(input.proposals) ? input.proposals : [];
  return {
    version: 1,
    proposals: proposals.map((proposal, index) => normalizeProposalRecord(proposal, {
      index,
      fallbackGoalId: options.fallbackGoalId,
      now: options.now,
    })),
  };
}

function normalizeBlockersDocument(document: unknown, options: { now: string }): BlockersDocument {
  const input = isPlainObject(document) ? document : {};
  const blockers = Array.isArray(input.blockers) ? input.blockers : [];
  return {
    version: 1,
    blockers: blockers.map((blocker, index) => normalizeBlockerRecord(blocker, { index, now: options.now })),
  };
}

function normalizeTaskRecord(
  task: unknown,
  options: {
    index: number;
    fallbackGoalId: string;
    now: string;
  },
): TasksDocument["tasks"][number] {
  const input = isPlainObject(task) ? task : {};
  return {
    id: readNonEmptyString(input.id, `legacy-task-${options.index + 1}`),
    goal_id: readNonEmptyString(input.goal_id, options.fallbackGoalId),
    title: readNonEmptyString(input.title, `Imported legacy task ${options.index + 1}`),
    status: isOneOf(input.status, ["queued", "ready", "in_progress", "verify_failed", "blocked", "done"]) ? input.status : "queued",
    priority: isOneOf(input.priority, ["P0", "P1", "P2", "P3"]) ? input.priority : "P1",
    depends_on: readStringArray(input.depends_on),
    acceptance: readStringArray(input.acceptance),
    file_hints: readStringArray(input.file_hints),
    retry_count: normalizeInteger(input.retry_count, 0),
    last_error: readOptionalString(input.last_error),
    updated_at: normalizeTimestamp(input.updated_at, options.now),
    commit_hash: readOptionalString(input.commit_hash),
    review_status: isOneOf(input.review_status, ["not_reviewed", "passed", "followup_required"]) ? input.review_status : "not_reviewed",
    source: isOneOf(input.source, ["proposal", "followup"]) ? input.source : "proposal",
    source_task_id: readOptionalString(input.source_task_id),
  };
}

function normalizeGoalRecord(
  goal: unknown,
  options: {
    index: number;
    now: string;
    activeGoalId: string | null;
    defaultRunMode: RunMode;
  },
): GoalsDocument["goals"][number] {
  const input = isPlainObject(goal) ? goal : {};
  const id = readNonEmptyString(input.id, options.activeGoalId ?? `${LEGACY_GOAL_ID}-${options.index + 1}`);
  const fallbackStatus = id === options.activeGoalId ? "active" : "approved";
  const status = isOneOf(input.status, ["draft", "awaiting_confirmation", "approved", "active", "completed", "blocked", "cancelled"])
    ? input.status
    : fallbackStatus;
  const createdAt = normalizeTimestamp(input.created_at, options.now);
  const completedAt = normalizeOptionalTimestamp(input.completed_at);
  return {
    id,
    title: readNonEmptyString(input.title, `Imported legacy goal ${options.index + 1}`),
    objective: readNonEmptyString(input.objective, "Migrate a legacy autonomy goal into the current control plane."),
    success_criteria: defaultIfEmpty(readStringArray(input.success_criteria), ["Review and refine the imported legacy goal."]),
    constraints: readStringArray(input.constraints),
    out_of_scope: readStringArray(input.out_of_scope),
    status,
    run_mode: isOneOf(input.run_mode, ["sprint", "cruise"]) ? input.run_mode : options.defaultRunMode,
    created_at: createdAt,
    approved_at: normalizeOptionalTimestamp(input.approved_at) ?? (status === "approved" || status === "active" || status === "completed" ? createdAt : null),
    completed_at: status === "completed" ? completedAt ?? createdAt : completedAt,
  };
}

function normalizeProposalRecord(
  proposal: unknown,
  options: {
    index: number;
    fallbackGoalId: string;
    now: string;
  },
): ProposalsDocument["proposals"][number] {
  const input = isPlainObject(proposal) ? proposal : {};
  return {
    goal_id: readNonEmptyString(input.goal_id, options.fallbackGoalId),
    status: isOneOf(input.status, ["awaiting_confirmation", "approved", "superseded", "cancelled"]) ? input.status : "awaiting_confirmation",
    summary: readNonEmptyString(input.summary, `Imported legacy proposal ${options.index + 1}.`),
    tasks: Array.isArray(input.tasks)
      ? input.tasks.map((task, taskIndex) => normalizeProposedTask(task, taskIndex))
      : [],
    created_at: normalizeTimestamp(input.created_at, options.now),
    approved_at: normalizeOptionalTimestamp(input.approved_at),
  };
}

function normalizeProposedTask(task: unknown, index: number): ProposalsDocument["proposals"][number]["tasks"][number] {
  const input = isPlainObject(task) ? task : {};
  const title = readNonEmptyString(input.title, `Imported proposed task ${index + 1}`);
  return {
    id: readNonEmptyString(input.id, `proposal-task-${index + 1}`),
    title,
    priority: isOneOf(input.priority, ["P0", "P1", "P2", "P3"]) ? input.priority : "P1",
    depends_on: readStringArray(input.depends_on),
    acceptance: defaultIfEmpty(readStringArray(input.acceptance), [title]),
    file_hints: readStringArray(input.file_hints),
  };
}

function normalizeBlockerRecord(
  blocker: unknown,
  options: {
    index: number;
    now: string;
  },
): BlockersDocument["blockers"][number] {
  const input = isPlainObject(blocker) ? blocker : {};
  return {
    id: readNonEmptyString(input.id, `legacy-blocker-${options.index + 1}`),
    task_id: readNonEmptyString(input.task_id, `legacy-task-${options.index + 1}`),
    question: readNonEmptyString(input.question, "Clarify the imported legacy blocker."),
    severity: isOneOf(input.severity, ["low", "medium", "high"]) ? input.severity : "medium",
    status: isOneOf(input.status, ["open", "resolved"]) ? input.status : "open",
    resolution: readOptionalString(input.resolution),
    opened_at: normalizeTimestamp(input.opened_at, options.now),
    resolved_at: normalizeOptionalTimestamp(input.resolved_at),
  };
}

function normalizeResultEntry(entry: unknown): AutonomyResults["planner"] {
  const defaults = createDefaultResultsDocument().planner;
  const input = mergeMissingFields(entry, defaults) as Record<string, unknown>;
  return {
    status: isOneOf(input.status, ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"])
      ? input.status
      : defaults.status,
    goal_id: readOptionalString(input.goal_id),
    task_id: readOptionalString(input.task_id),
    summary: readOptionalString(input.summary),
    happened_at: normalizeOptionalTimestamp(input.happened_at),
    sent_at: normalizeOptionalTimestamp(input.sent_at),
    verify_summary: readOptionalString(input.verify_summary),
    hash: readOptionalString(input.hash),
    message: readOptionalString(input.message),
    review_status: isOneOf(input.review_status, ["not_reviewed", "passed", "followup_required"]) ? input.review_status : null,
  };
}

function normalizeGoalTransitionSnapshot(value: unknown): AutonomyResults["latest_goal_transition"] {
  if (!isPlainObject(value)) {
    return null;
  }

  const fromGoalId = readOptionalString(value.from_goal_id);
  const toGoalId = readOptionalString(value.to_goal_id);
  if (!fromGoalId || !toGoalId) {
    return null;
  }

  return {
    from_goal_id: fromGoalId,
    to_goal_id: toGoalId,
    happened_at: normalizeOptionalTimestamp(value.happened_at),
  };
}

function createPlaceholderGoal(goalId: string, options: { now: string; runMode: RunMode }): GoalsDocument["goals"][number] {
  return {
    id: goalId,
    title: `Imported legacy goal (${goalId})`,
    objective: "Migrate a legacy autonomy goal into the current control plane.",
    success_criteria: ["Review and refine the imported legacy goal."],
    constraints: [],
    out_of_scope: [],
    status: "blocked",
    run_mode: options.runMode,
    created_at: options.now,
    approved_at: null,
    completed_at: null,
  };
}

function protectPlaceholderGoalReferences(options: {
  tasks: TasksDocument;
  blockers: BlockersDocument;
  placeholderGoalIds: readonly string[];
  currentTaskId: string | null;
  now: string;
}): {
  tasks: TasksDocument;
  blockers: BlockersDocument;
} {
  if (options.placeholderGoalIds.length === 0) {
    return {
      tasks: options.tasks,
      blockers: options.blockers,
    };
  }

  const placeholderGoalIds = new Set(options.placeholderGoalIds);
  const existingBlockerIds = new Set(options.blockers.blockers.map((blocker) => blocker.id));
  const touchedGoalIds = new Set<string>();
  const protectedTasks = options.tasks.tasks.map((task) => {
    if (!placeholderGoalIds.has(task.goal_id) || task.status === "done") {
      return task;
    }

    touchedGoalIds.add(task.goal_id);
    return {
      ...task,
      status: "blocked" as const,
      last_error: `Referenced goal ${task.goal_id} is missing from goals.json and requires human review.`,
      updated_at: options.now,
    };
  });

  const appendedBlockers = protectedTasks.flatMap((task) => {
    if (!placeholderGoalIds.has(task.goal_id) || task.status !== "blocked") {
      return [];
    }

    const blockerId = `install-missing-goal-${task.goal_id}-${task.id}`;
    if (existingBlockerIds.has(blockerId)) {
      return [];
    }

    existingBlockerIds.add(blockerId);
    return [{
      id: blockerId,
      task_id: task.id,
      question: `Task ${task.id} references missing goal ${task.goal_id}. Repair goals.json before resuming automation.`,
      severity: "high" as const,
      status: "open" as const,
      resolution: null,
      opened_at: options.now,
      resolved_at: null,
    }];
  });

  const syntheticGoalBlockers = options.placeholderGoalIds.flatMap((goalId) => {
    if (touchedGoalIds.has(goalId)) {
      return [];
    }

    const blockerId = `install-missing-goal-${goalId}`;
    if (existingBlockerIds.has(blockerId)) {
      return [];
    }

    existingBlockerIds.add(blockerId);
    return [{
      id: blockerId,
      task_id: options.currentTaskId ?? `goal::${goalId}`,
      question: `Goal ${goalId} is referenced by the control plane but missing from goals.json. Repair the goal definition before resuming automation.`,
      severity: "high" as const,
      status: "open" as const,
      resolution: null,
      opened_at: options.now,
      resolved_at: null,
    }];
  });

  return {
    tasks: {
      ...options.tasks,
      tasks: protectedTasks,
    },
    blockers: {
      ...options.blockers,
      blockers: [...options.blockers.blockers, ...appendedBlockers, ...syntheticGoalBlockers],
    },
  };
}

function mergeMissingFields(existing: unknown, defaults: unknown): unknown {
  if (Array.isArray(existing) || Array.isArray(defaults)) {
    return existing ?? defaults;
  }

  if (!isPlainObject(existing) || !isPlainObject(defaults)) {
    return existing ?? defaults;
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in existing)) {
      merged[key] = defaultValue;
      continue;
    }

    merged[key] = mergeMissingFields(existing[key], defaultValue);
  }

  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function readNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function defaultIfEmpty<T>(value: T[], fallback: T[]): T[] {
  return value.length > 0 ? value : fallback;
}

async function resolveGitTopLevel(targetPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    return path.resolve(stdout.trim());
  } catch {
    return null;
  }
}

async function detectCodexProcess(): Promise<boolean> {
  const shell = discoverPowerShellExecutable();
  if (!shell) {
    return false;
  }

  return detectCodexProcessProbe(shell).running;
}

async function hasBackgroundWorktreePrerequisites(
  paths: ReturnType<typeof resolveRepoPaths>,
  installMetadataPath: string,
): Promise<boolean> {
  const requiredPaths = [
    paths.agentsFile,
    paths.environmentFile,
    paths.configFile,
    paths.setupScript,
    paths.verifyScript,
    paths.smokeScript,
    paths.reviewScript,
    paths.goalFile,
    paths.journalFile,
    paths.tasksFile,
    paths.goalsFile,
    paths.proposalsFile,
    paths.stateFile,
    paths.settingsFile,
    paths.resultsFile,
    paths.verificationFile,
    paths.blockersFile,
    path.join(paths.schemaDir, "tasks.schema.json"),
    path.join(paths.schemaDir, "goals.schema.json"),
    path.join(paths.schemaDir, "proposals.schema.json"),
    path.join(paths.schemaDir, "state.schema.json"),
    path.join(paths.schemaDir, "settings.schema.json"),
    path.join(paths.schemaDir, "results.schema.json"),
    path.join(paths.schemaDir, "blockers.schema.json"),
    path.join(paths.schemaDir, "verification.schema.json"),
    installMetadataPath,
  ];

  for (const filePath of requiredPaths) {
    if (!(await pathExists(filePath))) {
      return false;
    }
  }

  return true;
}

function buildInstallMessage(
  repoRoot: string,
  isGitRepo: boolean,
  automationReady: boolean,
  createdCount: number,
  preflight: InstallPreflightSummary,
  threadBindingContext: ReturnType<typeof inspectThreadBindingContext>,
  operatorGuidance: ReturnType<typeof getOperatorThreadGuidance>,
): string {
  const base = createdCount > 0 ? `Installed codex-autonomy into ${repoRoot}.` : `codex-autonomy was already present in ${repoRoot}.`;
  const preflightNote = preflight.managed_diverged_paths.length > 0
    ? ` Preflight kept existing managed file(s) untouched: ${preflight.managed_diverged_paths.join(", ")}.`
    : "";
  const operatorNote = threadBindingContext.bindingHint
    ? ` ${threadBindingContext.bindingHint}${operatorGuidance.nextOperatorCommand ? ` Next operator command: ${operatorGuidance.nextOperatorCommand}.` : ""}`
    : "";

  if (!isGitRepo) {
    return `${base}${preflightNote} Warning: target is not a Git repository, so install stayed in detect-only mode.${operatorNote}`;
  }

  if (!automationReady) {
    return `${base}${preflightNote} Warning: install completed in detect-only mode. Existing managed files were left untouched. Use codex-autonomy upgrade-managed for a guided reconcile plan.${operatorNote}`;
  }

  return `${base}${preflightNote} Environment prerequisites are ready. Existing managed files were left untouched. Use codex-autonomy upgrade-managed for a guided reconcile plan.${operatorNote}`;
}

function buildNextAutomationSuggestions(isGitRepo: boolean): Array<{ name: string; purpose: string }> {
  const suggestions = [
    {
      name: "planner-cruise",
      purpose: "Maintain the ready window and proposal state for the active goal.",
    },
    {
      name: "worker-cruise",
      purpose: "Take one ready task at a time and run verify and review gates.",
    },
    {
      name: "reviewer-cruise",
      purpose: "Review worker output and record follow-up needs.",
    },
    {
      name: "reporter",
      purpose: isGitRepo
        ? "Send thread summaries, keep detailed run records in Inbox, and carry the sprint heartbeat loop when sprint mode is active."
        : "Send thread summaries and keep detailed run records in Inbox after the repo becomes automation-ready.",
    },
  ];

  return suggestions;
}
