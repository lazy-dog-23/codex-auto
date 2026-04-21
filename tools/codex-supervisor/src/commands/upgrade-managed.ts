import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { isDirectory, loadJsonFile, pathExists, writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { getInstallMetadataPath, getManagedFileClass, resolveRepoPaths } from "../shared/paths.js";
import { PRODUCT_VERSION } from "../shared/product.js";
import {
  getOperatorThreadGuidance,
  inspectThreadBindingContext,
  type OperatorThreadAction,
  type ThreadBindingState,
} from "../shared/thread-context.js";
import {
  getAgentsMarkdown,
  getAutonomyDecisionSkillMarkdown,
  getAutonomyIntakeSkillMarkdown,
  getAutonomyPlanSkillMarkdown,
  getAutonomyReportSkillMarkdown,
  getAutonomyReviewSkillMarkdown,
  getAutonomySprintSkillMarkdown,
  getAutonomyWorkSkillMarkdown,
  getCodexAutonomyLauncherScriptTemplate,
  getConfigTomlTemplate,
  getEnvironmentTomlTemplate,
  getInstallVerifyScriptTemplate,
  getReadmeManagedSectionMarkdown,
  getReviewScriptTemplate,
  getSetupWindowsScriptTemplate,
  getSmokeScriptTemplate,
  getDefaultJournalMarkdown,
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
import {
  MANAGED_README_SECTION_END,
  MANAGED_README_SECTION_START,
  classifyManagedReadme,
  extractManagedReadmeSection,
  upsertManagedReadmeSection,
} from "../shared/managed-readme.js";

type UpgradeDecision = "managed_match" | "safe_replace" | "auto_merge" | "manual_conflict" | "foreign_occupied";

interface UpgradeManagedOptions {
  target?: string;
  apply?: boolean;
  json?: boolean;
}

interface RebaselineManagedOptions {
  target?: string;
  json?: boolean;
}

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

interface ManagedUpgradePlanEntry {
  path: string;
  relative_path: string;
  template_id: string;
  management_class: "static_template" | "repo_customized" | "runtime_state";
  upgrade_blocking: boolean;
  status: UpgradeDecision;
  reason: string;
  installed_hash: string | null;
  current_hash: string | null;
  desired_hash: string;
  last_reconciled_product_version: string | null;
  action: "skip" | "replace" | "merge" | "manual";
}

interface UpgradeManagedSummary {
  target_path: string;
  install_metadata_path: string;
  apply: boolean;
  managed_match: number;
  safe_replace: number;
  auto_merge: number;
  manual_conflict: number;
  foreign_occupied: number;
  blocking_drift: number;
  advisory_drift: number;
  applied_paths: string[];
  pending_paths: string[];
  current_thread_id: string | null;
  current_thread_source: string | null;
  thread_binding_state: ThreadBindingState;
  thread_binding_hint: string | null;
  next_operator_action: OperatorThreadAction;
  next_operator_command: string | null;
}

interface UpgradeManagedResult {
  ok: boolean;
  message: string;
  summary: UpgradeManagedSummary;
  plan: ManagedUpgradePlanEntry[];
  warnings?: Array<{ code: string; message: string }>;
}

interface RebaselineManagedSummary {
  target_path: string;
  install_metadata_path: string;
  advisory_candidates: number;
  rebaselined_paths: string[];
  skipped_paths: string[];
  blocking_paths: string[];
  current_thread_id: string | null;
  current_thread_source: string | null;
  thread_binding_state: ThreadBindingState;
  thread_binding_hint: string | null;
  next_operator_action: OperatorThreadAction;
  next_operator_command: string | null;
}

interface RebaselineManagedResult {
  ok: boolean;
  message: string;
  summary: RebaselineManagedSummary;
  warnings?: Array<{ code: string; message: string }>;
}

interface ManagedInstallMetadataState {
  path: string;
  document: InstallMetadataDocument;
}

export interface ManagedUpgradeStateSummary {
  state: "not_installed" | "managed_match" | "managed_advisory_drift" | "managed_diverged" | "metadata_incomplete";
  summary: UpgradeManagedSummary | null;
}

export async function inspectManagedUpgradeState(targetPath: string): Promise<ManagedUpgradeStateSummary> {
  const repoRoot = path.resolve(targetPath);
  const installMetadataPath = getInstallMetadataPath(repoRoot);
  const paths = resolveRepoPaths(repoRoot);

  if (!(await pathExists(installMetadataPath))) {
    return {
      state: "not_installed",
      summary: null,
    };
  }

  let metadata: ManagedInstallMetadataState;
  try {
    metadata = await loadManagedInstallMetadata(installMetadataPath);
  } catch (error) {
    if (error instanceof CliError) {
      return {
        state: "metadata_incomplete",
        summary: null,
      };
    }
    throw error;
  }

  if (!Array.isArray(metadata.document.managed_files) || metadata.document.managed_files.length === 0) {
    return {
      state: "metadata_incomplete",
      summary: null,
    };
  }

  const plan = await buildManagedUpgradePlan(buildManagedControlSurfaceSpecs(resolveRepoPaths(repoRoot)), metadata.document);
  const summary = attachOperatorThreadGuidance(
    summarizeManagedUpgradePlan(repoRoot, installMetadataPath, false, plan),
    await loadRepoThreadBindingContext(paths),
  );
  const hasBlockingDivergence = plan.some((entry) => entry.upgrade_blocking);
  const hasAdvisoryDivergence = plan.some((entry) => !entry.upgrade_blocking && entry.status !== "managed_match");

  return {
    state: hasBlockingDivergence
      ? "managed_diverged"
      : hasAdvisoryDivergence
        ? "managed_advisory_drift"
        : "managed_match",
    summary,
  };
}

export async function runUpgradeManagedCommand(options: UpgradeManagedOptions = {}): Promise<UpgradeManagedResult> {
  const targetInput = options.target?.trim() || process.cwd();
  const targetPath = path.resolve(targetInput);

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`Upgrade target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const paths = resolveRepoPaths(targetPath);
  const installMetadataPath = getInstallMetadataPath(targetPath);
  const metadata = await loadManagedInstallMetadata(installMetadataPath);
  const specs = buildManagedControlSurfaceSpecs(paths);
  const plan = await buildManagedUpgradePlan(specs, metadata.document);
  const summary = attachOperatorThreadGuidance(
    summarizeManagedUpgradePlan(targetPath, installMetadataPath, options.apply === true, plan),
    await loadRepoThreadBindingContext(paths),
  );

  if (!options.apply) {
    return {
      ok: true,
      message: buildPlanMessage(summary),
      summary,
      plan,
      warnings: buildPlanWarnings(plan),
    };
  }

  const lock = await acquireCycleLock(paths.cycleLockFile, {
    command: "codex-autonomy upgrade-managed",
  });

  try {
    const appliedPaths = await applyManagedUpgradePlan(metadata.path, metadata.document, plan, specs);
    summary.applied_paths = appliedPaths;
    summary.pending_paths = plan
      .filter((entry) => entry.status === "manual_conflict" || entry.status === "foreign_occupied")
      .map((entry) => entry.relative_path);

    return {
      ok: true,
      message: buildApplyMessage(summary),
      summary,
      plan,
      warnings: buildApplyWarnings(plan, appliedPaths),
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export async function runRebaselineManagedCommand(
  options: RebaselineManagedOptions = {},
): Promise<RebaselineManagedResult> {
  const targetInput = options.target?.trim() || process.cwd();
  const targetPath = path.resolve(targetInput);

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`Rebaseline target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const paths = resolveRepoPaths(targetPath);
  const installMetadataPath = getInstallMetadataPath(targetPath);
  const metadata = await loadManagedInstallMetadata(installMetadataPath);
  const specs = buildManagedControlSurfaceSpecs(paths);
  const plan = await buildManagedUpgradePlan(specs, metadata.document);
  const summary = attachOperatorThreadGuidance(
    summarizeManagedRebaselinePlan(targetPath, installMetadataPath, plan),
    await loadRepoThreadBindingContext(paths),
  );

  if (summary.advisory_candidates === 0) {
    return {
      ok: true,
      message: `No advisory managed drift needs rebaselining in ${targetPath}.`,
      summary,
      warnings: summary.blocking_paths.length > 0
        ? [{
            code: "blocking_drift_present",
            message: `Blocking managed drift is still present: ${summary.blocking_paths.join(", ")}.`,
          }]
        : undefined,
    };
  }

  const lock = await acquireCycleLock(paths.cycleLockFile, {
    command: "codex-autonomy rebaseline-managed",
  });

  try {
    const { rebaselinedPaths, skippedPaths } = await rebaselineManagedMetadata(metadata.path, metadata.document, plan);
    const resultSummary: RebaselineManagedSummary = {
      ...summary,
      rebaselined_paths: rebaselinedPaths,
      skipped_paths: skippedPaths,
    };

    return {
      ok: true,
      message: buildRebaselineMessage(resultSummary),
      summary: resultSummary,
      warnings: buildRebaselineWarnings(resultSummary),
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerUpgradeManagedCommand(program: Command): void {
  program
    .command("upgrade-managed")
    .requiredOption("--target <path>", "Target repository root")
    .option("--apply", "Apply safe_replace and auto_merge entries")
    .option("--json", "Emit machine-readable JSON output")
    .description("Generate or apply a guided upgrade plan for managed control-surface files")
    .action(async (options: UpgradeManagedOptions) => {
      const result = await runUpgradeManagedCommand({
        target: options.target,
        apply: options.apply === true,
        json: options.json === true,
      });

      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.message);
      for (const entry of result.plan) {
        console.log(`${entry.status}: ${entry.relative_path} (${entry.reason})`);
      }
      if (result.warnings && result.warnings.length > 0) {
        for (const warning of result.warnings) {
          console.log(`warning: ${warning.message}`);
        }
      }
    });
}

export function registerRebaselineManagedCommand(program: Command): void {
  program
    .command("rebaseline-managed")
    .requiredOption("--target <path>", "Target repository root")
    .option("--json", "Emit machine-readable JSON output")
    .description("Accept advisory managed drift as the current repo-specific baseline without overwriting files")
    .action(async (options: RebaselineManagedOptions) => {
      const result = await runRebaselineManagedCommand({
        target: options.target,
        json: options.json === true,
      });

      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.message);
      for (const warning of result.warnings ?? []) {
        console.log(`warning: ${warning.message}`);
      }
    });
}

async function loadManagedInstallMetadata(filePath: string): Promise<ManagedInstallMetadataState> {
  if (!(await pathExists(filePath))) {
    throw new CliError(`Missing install metadata: ${filePath}`, CLI_EXIT_CODES.validation);
  }

  const document = normalizeInstallMetadataDocument(await loadJsonFile<unknown>(filePath));
  if (!Array.isArray(document.managed_files) || document.managed_files.length === 0) {
    throw new CliError(`Install metadata does not include managed_files: ${filePath}`, CLI_EXIT_CODES.validation);
  }

  return {
    path: filePath,
    document,
  };
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
    // Fall through to a default thread-context view when the state file cannot be read.
  }

  return inspectThreadBindingContext(null);
}

function attachOperatorThreadGuidance<T extends UpgradeManagedSummary | RebaselineManagedSummary>(
  summary: T,
  threadBindingContext: ReturnType<typeof inspectThreadBindingContext>,
): T {
  const operatorGuidance = getOperatorThreadGuidance(threadBindingContext);

  return {
    ...summary,
    current_thread_id: threadBindingContext.currentThreadId,
    current_thread_source: threadBindingContext.currentThreadSource,
    thread_binding_state: threadBindingContext.bindingState,
    thread_binding_hint: threadBindingContext.bindingHint,
    next_operator_action: operatorGuidance.nextOperatorAction,
    next_operator_command: operatorGuidance.nextOperatorCommand,
  };
}

function normalizeInstallMetadataDocument(value: unknown): InstallMetadataDocument {
  const input = isPlainObject(value) ? value : {};
  const managedFiles = Array.isArray(input.managed_files)
    ? input.managed_files.filter((item): item is ManagedInstallFileRecord => isManagedInstallFileRecord(item)).map(normalizeManagedInstallFileRecord)
    : [];

  return {
    version: normalizeInteger(input.version, 1),
    product_version: typeof input.product_version === "string" && input.product_version.trim().length > 0
      ? input.product_version.trim()
      : PRODUCT_VERSION,
    installed_at: typeof input.installed_at === "string" && input.installed_at.trim().length > 0
      ? input.installed_at.trim()
      : new Date(0).toISOString(),
    managed_paths: Array.isArray(input.managed_paths)
      ? input.managed_paths.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(normalizeRepoRelativePath)
      : [],
    source_repo: typeof input.source_repo === "string" && input.source_repo.trim().length > 0 ? input.source_repo.trim() : ".",
    managed_files: managedFiles.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function buildManagedUpgradePlan(
  specs: ManagedControlSurfaceSpec[],
  metadata: InstallMetadataDocument,
): Promise<ManagedUpgradePlanEntry[]> {
  const recordMap = new Map(metadata.managed_files.map((record) => [normalizeRepoRelativePath(record.path), record]));
  const plan: ManagedUpgradePlanEntry[] = [];

  for (const spec of specs) {
    const record = recordMap.get(spec.relative_path);
    if (!record) {
      if (isMarkdownSectionManagedSpec(spec)) {
        plan.push(await classifyUntrackedManagedReadmeFile(spec));
        continue;
      }

      const managementClass = getManagedFileClass(spec.relative_path);
      const desiredHash = getManagedSpecHash(spec, spec.content);
      try {
        const stats = await fs.lstat(spec.path);
        plan.push({
          path: spec.path,
          relative_path: spec.relative_path,
          template_id: spec.template_id,
          management_class: managementClass,
          upgrade_blocking: isBlockingManagedFileClass(managementClass),
          status: "foreign_occupied",
          reason: stats.isFile()
            ? "No managed metadata record exists for this existing file."
            : "No managed metadata record exists and the path is occupied by a non-file entry.",
          installed_hash: null,
          current_hash: stats.isFile() ? getManagedSpecHash(spec, await fs.readFile(spec.path, "utf8")) : null,
          desired_hash: desiredHash,
          last_reconciled_product_version: null,
          action: "manual",
        });
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }

        plan.push({
          path: spec.path,
          relative_path: spec.relative_path,
          template_id: spec.template_id,
          management_class: managementClass,
          upgrade_blocking: isBlockingManagedFileClass(managementClass),
          status: "safe_replace",
          reason: "New managed file is missing and can be added from the current template.",
          installed_hash: null,
          current_hash: null,
          desired_hash: desiredHash,
          last_reconciled_product_version: null,
          action: "replace",
        });
      }
      continue;
    }

    plan.push(await classifyManagedFile(spec, record));
  }

  return plan;
}

function isBlockingManagedFileClass(managementClass: ManagedInstallFileRecord["management_class"]): boolean {
  return managementClass === "static_template";
}

async function classifyManagedFile(
  spec: ManagedControlSurfaceSpec,
  record: ManagedInstallFileRecord,
): Promise<ManagedUpgradePlanEntry> {
  if (isMarkdownSectionManagedSpec(spec)) {
    return classifyManagedReadmeFile(spec, record);
  }

  const desiredHash = getManagedSpecHash(spec, spec.content);
  const upgradeBlocking = isBlockingManagedFileClass(record.management_class);
  const baselineOrigin = record.baseline_origin === "repo_specific" ? "repo_specific" : "template";

  try {
    const stats = await fs.lstat(spec.path);
    if (!stats.isFile()) {
      return {
        path: spec.path,
        relative_path: spec.relative_path,
        template_id: spec.template_id,
        management_class: record.management_class,
        upgrade_blocking: upgradeBlocking,
        status: "foreign_occupied",
        reason: "Managed path is occupied by a non-file entry.",
        installed_hash: record.installed_hash,
        current_hash: null,
        desired_hash: desiredHash,
        last_reconciled_product_version: record.last_reconciled_product_version,
        action: "manual",
      };
    }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: record.management_class,
      upgrade_blocking: upgradeBlocking,
      status: "safe_replace",
      reason: "Managed file is missing and can be recreated from the template.",
      installed_hash: record.installed_hash,
      current_hash: null,
      desired_hash: desiredHash,
      last_reconciled_product_version: record.last_reconciled_product_version,
      action: "replace",
    };
  }

  const currentContent = await fs.readFile(spec.path, "utf8");
  const currentHash = hashContent(currentContent);

  if (currentHash === record.installed_hash) {
    if (!upgradeBlocking && baselineOrigin === "repo_specific" && record.last_reconciled_product_version === PRODUCT_VERSION) {
      return {
        path: spec.path,
        relative_path: spec.relative_path,
        template_id: spec.template_id,
        management_class: record.management_class,
        upgrade_blocking: false,
        status: "managed_match",
        reason: "Managed file matches the currently accepted repo-specific baseline for its non-blocking management class.",
        installed_hash: record.installed_hash,
        current_hash: currentHash,
        desired_hash: desiredHash,
        last_reconciled_product_version: record.last_reconciled_product_version,
        action: "skip",
      };
    }

    if (contentMatchesTemplate(spec, currentContent)) {
      return {
        path: spec.path,
        relative_path: spec.relative_path,
        template_id: spec.template_id,
        management_class: record.management_class,
        upgrade_blocking: false,
        status: "managed_match",
        reason: upgradeBlocking
          ? "Managed file already matches the current template."
          : "Managed file is aligned closely enough for its non-blocking management class.",
        installed_hash: record.installed_hash,
        current_hash: currentHash,
        desired_hash: desiredHash,
        last_reconciled_product_version: record.last_reconciled_product_version,
        action: "skip",
      };
    }

    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: record.management_class,
      upgrade_blocking: upgradeBlocking,
      status: "safe_replace",
      reason: upgradeBlocking
        ? "Managed file is unchanged since install and can be replaced safely."
        : "An updated product template is available, but this file is managed as advisory drift only.",
      installed_hash: record.installed_hash,
      current_hash: currentHash,
      desired_hash: desiredHash,
      last_reconciled_product_version: record.last_reconciled_product_version,
      action: "replace",
    };
  }

  if (contentMatchesTemplate(spec, currentContent)) {
    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: record.management_class,
      upgrade_blocking: false,
      status: "managed_match",
      reason: upgradeBlocking
        ? "Managed file already matches the current template after local formatting or equivalent updates."
        : "Managed file already matches the current template or an equivalent repo-specific variant.",
      installed_hash: record.installed_hash,
      current_hash: currentHash,
      desired_hash: desiredHash,
      last_reconciled_product_version: record.last_reconciled_product_version,
      action: "skip",
    };
  }

  if (spec.kind === "json") {
    const merged = tryMergeManagedJson(currentContent, spec.content);
    if (merged) {
      return {
        path: spec.path,
        relative_path: spec.relative_path,
        template_id: spec.template_id,
        management_class: record.management_class,
        upgrade_blocking: upgradeBlocking,
        status: "auto_merge",
        reason: upgradeBlocking
          ? "Managed JSON file can be merged additively without conflicting changes."
          : "Managed JSON file can be merged additively, but the drift is advisory for this management class.",
        installed_hash: record.installed_hash,
        current_hash: currentHash,
        desired_hash: desiredHash,
        last_reconciled_product_version: record.last_reconciled_product_version,
        action: "merge",
      };
    }
  }

  return {
    path: spec.path,
    relative_path: spec.relative_path,
    template_id: spec.template_id,
    management_class: record.management_class,
    upgrade_blocking: upgradeBlocking,
    status: "manual_conflict",
    reason: upgradeBlocking
      ? "Managed file diverged from the installed baseline and cannot be safely reconciled automatically."
      : "Managed file diverged from the installed baseline, but this path is advisory and does not block automation readiness.",
    installed_hash: record.installed_hash,
    current_hash: currentHash,
    desired_hash: desiredHash,
    last_reconciled_product_version: record.last_reconciled_product_version,
    action: "manual",
  };
}

async function classifyUntrackedManagedReadmeFile(
  spec: ManagedControlSurfaceSpec,
): Promise<ManagedUpgradePlanEntry> {
  const desiredHash = getManagedSpecHash(spec, spec.content);
  const managementClass = getManagedFileClass(spec.relative_path);

  try {
    const stats = await fs.lstat(spec.path);
    if (!stats.isFile()) {
      return {
        path: spec.path,
        relative_path: spec.relative_path,
        template_id: spec.template_id,
        management_class: managementClass,
        upgrade_blocking: false,
        status: "manual_conflict",
        reason: "README.md is not a regular file, so the managed section cannot be adopted automatically.",
        installed_hash: null,
        current_hash: null,
        desired_hash: desiredHash,
        last_reconciled_product_version: null,
        action: "manual",
      };
    }
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: managementClass,
      upgrade_blocking: false,
      status: "safe_replace",
      reason: "README.md is missing and the managed section can be created safely.",
      installed_hash: null,
      current_hash: null,
      desired_hash: desiredHash,
      last_reconciled_product_version: null,
      action: "replace",
    };
  }

  const currentContent = await fs.readFile(spec.path, "utf8");
  const classified = classifyManagedReadme(currentContent);
  if (!classified.ok) {
    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: managementClass,
      upgrade_blocking: false,
      status: "manual_conflict",
      reason: classified.reasonMessage ?? "README.md is outside the managed section policy.",
      installed_hash: null,
      current_hash: null,
      desired_hash: desiredHash,
      last_reconciled_product_version: null,
      action: "manual",
    };
  }

  const currentSection = extractManagedReadmeSection(currentContent);
  const currentHash = currentSection === null ? hashContent(currentContent) : hashContent(currentSection);
  if (currentSection !== null && getManagedSpecHash(spec, currentSection) === desiredHash) {
    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: managementClass,
      upgrade_blocking: false,
      status: "managed_match",
      reason: "README.md already contains the expected managed section.",
      installed_hash: null,
      current_hash: currentHash,
      desired_hash: desiredHash,
      last_reconciled_product_version: null,
      action: "skip",
    };
  }

  return {
    path: spec.path,
    relative_path: spec.relative_path,
    template_id: spec.template_id,
    management_class: managementClass,
    upgrade_blocking: false,
    status: "safe_replace",
    reason: currentSection === null
      ? "README.md is manageable and can adopt the codex-autonomy section without replacing the whole file."
      : "README.md has a managed section that can be refreshed safely.",
    installed_hash: null,
    current_hash: currentHash,
    desired_hash: desiredHash,
    last_reconciled_product_version: null,
    action: "replace",
  };
}

async function classifyManagedReadmeFile(
  spec: ManagedControlSurfaceSpec,
  record: ManagedInstallFileRecord,
): Promise<ManagedUpgradePlanEntry> {
  const desiredHash = getManagedSpecHash(spec, spec.content);
  const baselineOrigin = record.baseline_origin === "repo_specific" ? "repo_specific" : "template";

  try {
    const stats = await fs.lstat(spec.path);
    if (!stats.isFile()) {
      return {
        path: spec.path,
        relative_path: spec.relative_path,
        template_id: spec.template_id,
        management_class: record.management_class,
        upgrade_blocking: false,
        status: "foreign_occupied",
        reason: "README.md is occupied by a non-file entry.",
        installed_hash: record.installed_hash,
        current_hash: null,
        desired_hash: desiredHash,
        last_reconciled_product_version: record.last_reconciled_product_version,
        action: "manual",
      };
    }
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: record.management_class,
      upgrade_blocking: false,
      status: "safe_replace",
      reason: "README.md is missing and the managed section can be recreated safely.",
      installed_hash: record.installed_hash,
      current_hash: null,
      desired_hash: desiredHash,
      last_reconciled_product_version: record.last_reconciled_product_version,
      action: "replace",
    };
  }

  const currentContent = await fs.readFile(spec.path, "utf8");
  const classified = classifyManagedReadme(currentContent);
  if (!classified.ok) {
    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: record.management_class,
      upgrade_blocking: false,
      status: "manual_conflict",
      reason: classified.reasonMessage ?? "README.md is outside the managed section policy.",
      installed_hash: record.installed_hash,
      current_hash: null,
      desired_hash: desiredHash,
      last_reconciled_product_version: record.last_reconciled_product_version,
      action: "manual",
    };
  }

  const currentSection = extractManagedReadmeSection(currentContent);
  const currentHash = currentSection === null ? hashContent(currentContent) : hashContent(currentSection);

  if (currentSection !== null && getManagedSpecHash(spec, currentSection) === desiredHash) {
    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: record.management_class,
      upgrade_blocking: false,
      status: "managed_match",
      reason: "README.md already matches the current managed section template.",
      installed_hash: record.installed_hash,
      current_hash: currentHash,
      desired_hash: desiredHash,
      last_reconciled_product_version: record.last_reconciled_product_version,
      action: "skip",
    };
  }

  if (currentHash === record.installed_hash
    && baselineOrigin === "repo_specific"
    && record.last_reconciled_product_version === PRODUCT_VERSION
    && currentSection !== null) {
    return {
      path: spec.path,
      relative_path: spec.relative_path,
      template_id: spec.template_id,
      management_class: record.management_class,
      upgrade_blocking: false,
      status: "managed_match",
      reason: "README.md matches the accepted repo-specific managed section baseline.",
      installed_hash: record.installed_hash,
      current_hash: currentHash,
      desired_hash: desiredHash,
      last_reconciled_product_version: record.last_reconciled_product_version,
      action: "skip",
    };
  }

  return {
    path: spec.path,
    relative_path: spec.relative_path,
    template_id: spec.template_id,
    management_class: record.management_class,
    upgrade_blocking: false,
    status: "safe_replace",
    reason: currentSection === null
      ? "README.md can adopt the managed section without taking ownership of the whole file."
      : "README.md has a manageable codex-autonomy section that can be refreshed safely.",
    installed_hash: record.installed_hash,
    current_hash: currentHash,
    desired_hash: desiredHash,
    last_reconciled_product_version: record.last_reconciled_product_version,
    action: "replace",
  };
}

async function applyManagedUpgradePlan(
  metadataPath: string,
  metadata: InstallMetadataDocument,
  plan: ManagedUpgradePlanEntry[],
  specs: ManagedControlSurfaceSpec[],
): Promise<string[]> {
  const specMap = new Map(specs.map((spec) => [spec.relative_path, spec]));
  const appliedPaths: string[] = [];

  for (const entry of plan) {
    if (entry.status !== "safe_replace" && entry.status !== "auto_merge") {
      continue;
    }

    const spec = specMap.get(entry.relative_path);
    if (!spec) {
      continue;
    }

    await ensureParentDirectory(spec.path);
    if (entry.status === "safe_replace") {
      if (isMarkdownSectionManagedSpec(spec)) {
        let existingContent: string | null = null;
        try {
          existingContent = await fs.readFile(spec.path, "utf8");
        } catch (error) {
          if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }

        const updated = upsertManagedReadmeSection(existingContent, spec.content);
        if (!updated.ok || typeof updated.content !== "string") {
          throw new CliError(
            updated.reasonMessage ?? "README.md could not be updated with the managed section.",
            CLI_EXIT_CODES.validation,
          );
        }

        await writeTextFileAtomic(spec.path, updated.content);
      } else {
        await writeManagedFile(spec.path, spec.content, spec.kind);
      }
      appliedPaths.push(entry.relative_path);
      continue;
    }

    const currentContent = await fs.readFile(spec.path, "utf8");
    const merged = tryMergeManagedJson(currentContent, spec.content);
    if (!merged) {
      continue;
    }

    await writeManagedFile(spec.path, merged.content, spec.kind);
    appliedPaths.push(entry.relative_path);
  }

  const refreshedRecordsMap = new Map(
    metadata.managed_files.map((record) => [normalizeRepoRelativePath(record.path), normalizeManagedInstallFileRecord(record)]),
  );
  const pathsToRefresh = new Set([
    ...appliedPaths,
    ...plan.filter((entry) => entry.status === "managed_match").map((entry) => entry.relative_path),
  ]);

  for (const relativePath of pathsToRefresh) {
    const spec = specMap.get(relativePath);
    if (!spec || !(await pathExists(spec.path))) {
      continue;
    }

    const currentContent = await fs.readFile(spec.path, "utf8");
    refreshedRecordsMap.set(relativePath, buildManagedInstallFileRecordFromContent(spec, currentContent));
  }

  const refreshedRecords = [...refreshedRecordsMap.values()];

  await writeJsonAtomic(metadataPath, {
    ...metadata,
    product_version: PRODUCT_VERSION,
    managed_paths: buildManagedInstallMetadataPaths(refreshedRecords),
    managed_files: refreshedRecords.sort((left, right) => left.path.localeCompare(right.path)),
  });

  return appliedPaths;
}

async function rebaselineManagedMetadata(
  metadataPath: string,
  metadata: InstallMetadataDocument,
  plan: ManagedUpgradePlanEntry[],
): Promise<{
  rebaselinedPaths: string[];
  skippedPaths: string[];
}> {
  const rebaselinedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const eligiblePaths = new Set(
    plan
      .filter((entry) => !entry.upgrade_blocking && entry.current_hash && entry.status !== "foreign_occupied")
      .map((entry) => entry.relative_path),
  );

  const refreshedRecords = metadata.managed_files.map((record) => {
    const relativePath = normalizeRepoRelativePath(record.path);
    if (!eligiblePaths.has(relativePath)) {
      return record;
    }

    const entry = plan.find((candidate) => candidate.relative_path === relativePath);
    if (!entry?.current_hash) {
      skippedPaths.push(relativePath);
      return record;
    }

    rebaselinedPaths.push(relativePath);
    return {
      ...record,
      installed_hash: entry.current_hash,
      last_reconciled_product_version: PRODUCT_VERSION,
      baseline_origin: "repo_specific" as const,
    };
  });

  const skippedSet = new Set(skippedPaths);
  for (const entry of plan) {
    if (!entry.upgrade_blocking && entry.status !== "managed_match" && !rebaselinedPaths.includes(entry.relative_path) && !skippedSet.has(entry.relative_path)) {
      skippedPaths.push(entry.relative_path);
      skippedSet.add(entry.relative_path);
    }
  }

  await writeJsonAtomic(metadataPath, {
    ...metadata,
    product_version: PRODUCT_VERSION,
    managed_paths: buildManagedInstallMetadataPaths(refreshedRecords),
    managed_files: refreshedRecords.sort((left, right) => left.path.localeCompare(right.path)),
  });

  return {
    rebaselinedPaths: rebaselinedPaths.sort(),
    skippedPaths: skippedPaths.sort(),
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
      path: path.join(paths.repoRoot, ".agents", "skills", "$autonomy-decision", "SKILL.md"),
      relative_path: ".agents/skills/$autonomy-decision/SKILL.md",
      template_id: "autonomy_decision_skill_markdown",
      kind: "text",
      content: `${getAutonomyDecisionSkillMarkdown()}\n`,
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
      path: paths.autonomyCliScript,
      relative_path: "scripts/codex-autonomy.ps1",
      template_id: "codex_autonomy_ps1",
      kind: "text",
      content: getCodexAutonomyLauncherScriptTemplate(),
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
      content: `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`,
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
      path: paths.slicesFile,
      relative_path: "autonomy/slices.json",
      template_id: "slices_json",
      kind: "json",
      content: `${JSON.stringify(createDefaultSlicesDocument(), null, 2)}\n`,
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
      path: paths.decisionPolicyFile,
      relative_path: "autonomy/decision-policy.json",
      template_id: "decision_policy_json",
      kind: "json",
      content: `${JSON.stringify(createDefaultDecisionPolicy(), null, 2)}\n`,
    },
    {
      path: paths.blockersFile,
      relative_path: "autonomy/blockers.json",
      template_id: "blockers_json",
      kind: "json",
      content: `${JSON.stringify({ version: 1, blockers: [] }, null, 2)}\n`,
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
      path: path.join(paths.schemaDir, "slices.schema.json"),
      relative_path: "autonomy/schema/slices.schema.json",
      template_id: "slices_schema_json",
      kind: "json",
      content: `${JSON.stringify(slicesSchema, null, 2)}\n`,
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
    {
      path: path.join(paths.schemaDir, "decision-policy.schema.json"),
      relative_path: "autonomy/schema/decision-policy.schema.json",
      template_id: "decision_policy_schema_json",
      kind: "json",
      content: `${JSON.stringify(decisionPolicySchema, null, 2)}\n`,
    },
  ];

  return specs.map((spec) => ({
    ...spec,
    management_class: getManagedFileClass(spec.relative_path),
  }));
}

function buildPlanWarnings(plan: ManagedUpgradePlanEntry[]): Array<{ code: string; message: string }> {
  const conflicts = plan.filter((entry) => entry.status === "manual_conflict" || entry.status === "foreign_occupied");
  return conflicts.length > 0
    ? [{
        code: "upgrade_requires_manual_review",
        message: `Managed upgrade plan contains ${conflicts.length} path(s) that need manual review.`,
      }]
    : [];
}

function buildApplyWarnings(plan: ManagedUpgradePlanEntry[], appliedPaths: string[]): Array<{ code: string; message: string }> {
  const warnings = buildPlanWarnings(plan);
  if (appliedPaths.length > 0) {
    warnings.push({ code: "upgrade_applied", message: `Applied ${appliedPaths.length} managed file(s).` });
  }

  return warnings;
}

function buildRebaselineWarnings(summary: RebaselineManagedSummary): Array<{ code: string; message: string }> {
  const warnings: Array<{ code: string; message: string }> = [];
  if (summary.rebaselined_paths.length > 0) {
    warnings.push({
      code: "advisory_drift_rebaselined",
      message: `Accepted ${summary.rebaselined_paths.length} advisory managed file(s) as the new repo-specific baseline.`,
    });
  }

  if (summary.skipped_paths.length > 0) {
    warnings.push({
      code: "rebaseline_skipped_paths",
      message: `Skipped ${summary.skipped_paths.length} advisory path(s) during rebaseline.`,
    });
  }

  if (summary.blocking_paths.length > 0) {
    warnings.push({
      code: "blocking_drift_present",
      message: `Blocking managed drift still exists for ${summary.blocking_paths.length} path(s): ${summary.blocking_paths.join(", ")}.`,
    });
  }

  return warnings;
}

function summarizeManagedUpgradePlan(
  repoRoot: string,
  installMetadataPath: string,
  apply: boolean,
  plan: ManagedUpgradePlanEntry[],
): UpgradeManagedSummary {
  const counts = countManagedUpgradePlan(plan);
  const blockingDrift = plan.filter((entry) => entry.upgrade_blocking && entry.status !== "managed_match").length;
  const advisoryDrift = plan.filter((entry) => !entry.upgrade_blocking && entry.status !== "managed_match").length;
  return {
    target_path: repoRoot,
    install_metadata_path: installMetadataPath,
    apply,
    managed_match: counts.managed_match,
    safe_replace: counts.safe_replace,
    auto_merge: counts.auto_merge,
    manual_conflict: counts.manual_conflict,
    foreign_occupied: counts.foreign_occupied,
    blocking_drift: blockingDrift,
    advisory_drift: advisoryDrift,
    applied_paths: [],
    pending_paths: plan
      .filter((entry) => entry.status === "manual_conflict" || entry.status === "foreign_occupied")
      .map((entry) => entry.relative_path),
    current_thread_id: null,
    current_thread_source: null,
    thread_binding_state: "unbound_current_unavailable",
    thread_binding_hint: null,
    next_operator_action: "bind_explicit_thread",
    next_operator_command: null,
  };
}

function summarizeManagedRebaselinePlan(
  repoRoot: string,
  installMetadataPath: string,
  plan: ManagedUpgradePlanEntry[],
): RebaselineManagedSummary {
  return {
    target_path: repoRoot,
    install_metadata_path: installMetadataPath,
    advisory_candidates: plan.filter((entry) => !entry.upgrade_blocking && entry.current_hash && entry.status !== "managed_match" && entry.status !== "foreign_occupied").length,
    rebaselined_paths: [],
    skipped_paths: [],
    blocking_paths: plan
      .filter((entry) => entry.upgrade_blocking && entry.status !== "managed_match")
      .map((entry) => entry.relative_path),
    current_thread_id: null,
    current_thread_source: null,
    thread_binding_state: "unbound_current_unavailable",
    thread_binding_hint: null,
    next_operator_action: "bind_explicit_thread",
    next_operator_command: null,
  };
}

function buildPlanMessage(summary: UpgradeManagedSummary): string {
  return [
    `Generated upgrade plan for ${summary.target_path}.`,
    `managed_match=${summary.managed_match}, safe_replace=${summary.safe_replace}, auto_merge=${summary.auto_merge}, manual_conflict=${summary.manual_conflict}, foreign_occupied=${summary.foreign_occupied}, blocking_drift=${summary.blocking_drift}, advisory_drift=${summary.advisory_drift}.`,
    summary.pending_paths.length > 0 ? `Pending manual review: ${summary.pending_paths.join(", ")}.` : "No manual review is required.",
    buildOperatorThreadNote(summary),
  ].filter(Boolean).join(" ");
}

function buildApplyMessage(summary: UpgradeManagedSummary): string {
  return [
    `Applied guided managed upgrade for ${summary.target_path}.`,
    `applied=${summary.applied_paths.length}, manual_conflict=${summary.manual_conflict}, foreign_occupied=${summary.foreign_occupied}.`,
    summary.pending_paths.length > 0 ? `Skipped: ${summary.pending_paths.join(", ")}.` : "All managed paths were reconciled.",
    buildOperatorThreadNote(summary),
  ].filter(Boolean).join(" ");
}

function buildRebaselineMessage(summary: RebaselineManagedSummary): string {
  const parts = [
    `Rebaselined ${summary.rebaselined_paths.length} advisory managed file(s) in ${summary.target_path}.`,
    summary.blocking_paths.length > 0
      ? `Blocking drift still exists for ${summary.blocking_paths.length} path(s).`
      : "No blocking managed drift remains.",
  ];

  if (summary.skipped_paths.length > 0) {
    parts.push(`Skipped ${summary.skipped_paths.length} path(s): ${summary.skipped_paths.join(", ")}.`);
  }

  const operatorNote = buildOperatorThreadNote(summary);
  if (operatorNote) {
    parts.push(operatorNote);
  }

  return parts.join(" ");
}

function buildOperatorThreadNote(summary: Pick<
  UpgradeManagedSummary | RebaselineManagedSummary,
  "thread_binding_hint" | "next_operator_command"
>): string {
  if (!summary.thread_binding_hint) {
    return "";
  }

  return `${summary.thread_binding_hint}${summary.next_operator_command ? ` Next operator command: ${summary.next_operator_command}.` : ""}`;
}

function countManagedUpgradePlan(plan: ManagedUpgradePlanEntry[]): Record<UpgradeDecision, number> {
  const counts: Record<UpgradeDecision, number> = {
    managed_match: 0,
    safe_replace: 0,
    auto_merge: 0,
    manual_conflict: 0,
    foreign_occupied: 0,
  };

  for (const entry of plan) {
    counts[entry.status] += 1;
  }

  return counts;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeManagedFile(filePath: string, content: string, kind: ManagedControlSurfaceSpec["kind"]): Promise<void> {
  if (kind === "json") {
    await writeJsonAtomic(filePath, JSON.parse(content));
    return;
  }

  await writeTextFileAtomic(filePath, content);
}

function contentMatchesTemplate(spec: ManagedControlSurfaceSpec, currentContent: string): boolean {
  if (spec.kind === "json") {
    try {
      return deepEqualJson(JSON.parse(currentContent), JSON.parse(spec.content));
    } catch {
      return false;
    }
  }

  if (isMarkdownSectionManagedSpec(spec)) {
    const section = extractManagedReadmeSection(currentContent);
    return section !== null && normalizeText(section) === normalizeText(spec.content);
  }

  return normalizeText(currentContent) === normalizeText(spec.content);
}

function tryMergeManagedJson(currentContent: string, desiredContent: string): { content: string } | null {
  let currentJson: unknown;
  let desiredJson: unknown;
  try {
    currentJson = JSON.parse(currentContent);
    desiredJson = JSON.parse(desiredContent);
  } catch {
    return null;
  }

  if (!isPlainObject(currentJson) || !isPlainObject(desiredJson)) {
    return null;
  }

  const merged = mergeJsonObjects(currentJson, desiredJson);
  if (!merged) {
    return null;
  }

  return {
    content: `${JSON.stringify(merged, null, 2)}\n`,
  };
}

function mergeJsonObjects(current: Record<string, unknown>, desired: Record<string, unknown>): Record<string, unknown> | null {
  const merged: Record<string, unknown> = cloneJsonValue(current) as Record<string, unknown>;

  for (const [key, desiredValue] of Object.entries(desired)) {
    if (!(key in current)) {
      merged[key] = cloneJsonValue(desiredValue);
      continue;
    }

    const currentValue = current[key];
    if (deepEqualJson(currentValue, desiredValue)) {
      continue;
    }

    if (isPlainObject(currentValue) && isPlainObject(desiredValue)) {
      const nested = mergeJsonObjects(currentValue, desiredValue);
      if (!nested) {
        return null;
      }

      merged[key] = nested;
      continue;
    }

    return null;
  }

  return merged;
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => deepEqualJson(item, right[index]));
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key, index) => key === rightKeys[index] && deepEqualJson(left[key], right[key]));
  }

  return false;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isMarkdownSectionManagedSpec(spec: ManagedControlSurfaceSpec): boolean {
  return spec.kind === "text" && spec.content_mode === "markdown_section";
}

function getManagedSpecHash(spec: ManagedControlSurfaceSpec, content: string): string {
  if (!isMarkdownSectionManagedSpec(spec)) {
    return hashContent(content);
  }

  return hashContent(normalizeText(content));
}

function buildManagedInstallMetadataPaths(records: ManagedInstallFileRecord[]): string[] {
  return Array.from(new Set([
    "autonomy/install.json",
    ...records.map((record) => normalizeRepoRelativePath(record.path)),
  ])).sort();
}

function buildManagedInstallFileRecordFromContent(
  spec: ManagedControlSurfaceSpec,
  currentContent: string,
): ManagedInstallFileRecord {
  const installedContent = isMarkdownSectionManagedSpec(spec)
    ? extractManagedReadmeSection(currentContent) ?? spec.content
    : currentContent;

  return {
    path: spec.relative_path,
    template_id: spec.template_id,
    installed_hash: getManagedSpecHash(spec, installedContent),
    last_reconciled_product_version: PRODUCT_VERSION,
    management_class: spec.management_class,
    baseline_origin: contentMatchesTemplate(spec, currentContent) ? "template" : "repo_specific",
    content_mode: spec.content_mode,
    section_start_marker: spec.section_start_marker,
    section_end_marker: spec.section_end_marker,
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function normalizeRepoRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function normalizeManagedInstallFileRecord(value: ManagedInstallFileRecord): ManagedInstallFileRecord {
  return {
    path: normalizeRepoRelativePath(value.path),
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
    && typeof record.template_id === "string"
    && typeof record.installed_hash === "string"
    && typeof record.last_reconciled_product_version === "string";
}

function normalizeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
