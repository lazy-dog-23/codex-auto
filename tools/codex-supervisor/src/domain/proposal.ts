import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import type { GoalRecord, ProposedTask } from "../contracts/autonomy.js";
import { loadJsonFile, pathExists, readTextFile } from "../infra/fs.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  ".next",
  "out",
  "tmp",
  "temp",
  "venv",
  ".venv",
]);

const SYSTEM_AUDIT_KEYWORDS = [
  "audit",
  "review",
  "verify",
  "security",
  "secure",
  "hardening",
  "robust",
  "robustness",
  "stability",
  "stable",
  "reliability",
  "reliable",
  "usability",
  "usable",
  "extensibility",
  "extend",
  "performance",
  "performance",
  "resilience",
  "resilient",
  "diagnose",
  "inspect",
  "system",
  "risk",
  "safety",
];

const CHINESE_AUDIT_PHRASES = [
  "安全",
  "健壮",
  "健全",
  "可用性",
  "上手难度",
  "扩展性",
  "体检",
  "审查",
  "审视",
  "检查",
  "评估",
  "加固",
  "稳健",
];

const CONTROL_SURFACE_HINTS = [
  "AGENTS.md",
  "README.md",
];

const CONTROL_SURFACE_PATH_HINTS = [
  ".agents/skills/$autonomy-plan/SKILL.md",
  ".agents/skills/$autonomy-work/SKILL.md",
  ".codex/config.toml",
  ".codex/environments/environment.toml",
  "autonomy/goal.md",
  "autonomy/goals.json",
  "autonomy/proposals.json",
  "autonomy/tasks.json",
  "autonomy/state.json",
  "autonomy/results.json",
  "autonomy/settings.json",
  "autonomy/blockers.json",
  "scripts/verify.ps1",
  "scripts/review.ps1",
  "scripts/smoke.ps1",
  "scripts/setup.windows.ps1",
];

const VISIBLE_HIDDEN_DIRECTORIES = new Set([
  ".agents",
  ".codex",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".ps1", ".sh", ".py"]);

export interface RepoAwareProposalSignals {
  goal_style: "system_audit" | "generic";
  agents_path: string | null;
  package_manifest_paths: string[];
  package_script_names: string[];
  documentation_paths: string[];
  matched_paths: string[];
  control_tokens: string[];
}

export interface RepoAwareFallbackProposal {
  summary: string;
  tasks: ProposedTask[];
  signals: RepoAwareProposalSignals;
}

interface PackageManifestSignals {
  path: string;
  scripts: string[];
}

interface RepoFileRecord {
  absolutePath: string;
  relativePath: string;
}

export async function buildRepoAwareFallbackProposal(goal: GoalRecord, repoRoot: string): Promise<RepoAwareFallbackProposal> {
  const resolvedRoot = resolve(repoRoot);
  const files = await collectRepoFiles(resolvedRoot, 5);
  const signals = await collectRepoAwareSignals(files, goal);
  const taskBlueprints = signals.goal_style === "system_audit"
    ? buildSystemAuditBlueprints(goal, signals)
    : buildGenericBlueprints(goal, signals);
  const tasks = finalizeBlueprints(goal, taskBlueprints);

  return {
    summary: buildRepoAwareSummary(goal, signals, tasks.length),
    tasks,
    signals,
  };
}

async function collectRepoAwareSignals(
  files: RepoFileRecord[],
  goal: GoalRecord,
): Promise<RepoAwareProposalSignals> {
  const packageManifests = await collectPackageManifests(files);
  const packageScriptNames = [...new Set(packageManifests.flatMap((manifest) => manifest.scripts))].sort((left, right) => left.localeCompare(right));
  const documentationPaths = collectDocumentationPaths(files);
  const agentsPath = files.find((file) => file.relativePath === "AGENTS.md")?.relativePath ?? null;
  const controlTokens = dedupeStrings([
    ...packageScriptNames,
    ...(await collectDocumentTokens(files)),
  ]);
  const matchedPaths = selectMatchedPaths(files, goal, controlTokens);
  const goal_style = detectGoalStyle(goal);

  return {
    goal_style,
    agents_path: agentsPath,
    package_manifest_paths: packageManifests.map((manifest) => manifest.path),
    package_script_names: packageScriptNames,
    documentation_paths: documentationPaths,
    matched_paths: matchedPaths,
    control_tokens: controlTokens,
  };
}

async function collectPackageManifests(files: RepoFileRecord[]): Promise<PackageManifestSignals[]> {
  const manifests: PackageManifestSignals[] = [];

  for (const file of files) {
    if (basename(file.relativePath) !== "package.json") {
      continue;
    }

    try {
      const manifest = await loadJsonFile<Record<string, unknown>>(file.absolutePath);
      const scripts = collectPackageScripts(manifest.scripts);
      manifests.push({
        path: file.relativePath,
        scripts,
      });
    } catch {
      continue;
    }
  }

  manifests.sort((left, right) => left.path.localeCompare(right.path));
  return manifests;
}

function collectPackageScripts(scriptsValue: unknown): string[] {
  if (!scriptsValue || typeof scriptsValue !== "object" || Array.isArray(scriptsValue)) {
    return [];
  }

  return Object.entries(scriptsValue)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

function collectDocumentationPaths(files: RepoFileRecord[]): string[] {
  return files
    .filter((file) => {
      if (file.relativePath === "README.md") {
        return true;
      }

      if (!file.relativePath.startsWith(`docs${sep}`) && !file.relativePath.startsWith("docs/")) {
        return false;
      }

      return DOC_EXTENSIONS.has(fileExtension(file.relativePath));
    })
    .map((file) => file.relativePath)
    .sort((left, right) => left.localeCompare(right));
}

async function collectDocumentTokens(files: RepoFileRecord[]): Promise<string[]> {
  const targets = files.filter((file) => {
    if (file.relativePath === "AGENTS.md" || file.relativePath === "README.md") {
      return true;
    }

    return file.relativePath.startsWith(`docs${sep}`) || file.relativePath.startsWith("docs/");
  });

  const tokens: string[] = [];
  for (const target of targets) {
    try {
      const content = await readTextFile(target.absolutePath);
      tokens.push(...extractGoalTokens(content));
    } catch {
      continue;
    }
  }

  return tokens;
}

function selectMatchedPaths(files: RepoFileRecord[], goal: GoalRecord, controlTokens: string[]): string[] {
  const goalText = [
    goal.title,
    goal.objective,
    ...goal.success_criteria,
    ...goal.constraints,
    ...goal.out_of_scope,
  ].join(" ");
  const tokens = dedupeStrings([...extractGoalTokens(goalText), ...controlTokens]);
  const goalStyle = detectGoalStyle(goal);

  return files
    .map((file) => ({
      path: file.relativePath,
      score: scoreRepoFile(file.relativePath, tokens, goalStyle),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 12)
    .map((entry) => entry.path);
}

function scoreRepoFile(pathValue: string, tokens: string[], goalStyle: "system_audit" | "generic"): number {
  const normalized = pathValue.replace(/\\/g, "/").toLowerCase();
  const basenameValue = basename(normalized);
  let score = 0;

  if (normalized === "agents.md") {
    score += 100;
  }
  if (normalized === "readme.md") {
    score += 96;
  }
  if (basenameValue === "package.json") {
    score += 94;
  }
  if (normalized.startsWith("autonomy/")) {
    score += 22;
  }
  if (normalized.startsWith(".codex/")) {
    score += 20;
  }
  if (normalized.startsWith("scripts/")) {
    score += 18;
  }
  if (normalized.startsWith("docs/")) {
    score += 16;
  }
  if (normalized.startsWith("src/commands/")) {
    score += 14;
  }
  if (normalized.startsWith("src/domain/")) {
    score += 13;
  }
  if (normalized.startsWith("src/infra/")) {
    score += 13;
  }
  if (normalized.startsWith("test/")) {
    score += 11;
  }

  if (goalStyle === "system_audit") {
    if (normalized.includes("doctor")) score += 20;
    if (normalized.includes("install")) score += 18;
    if (normalized.includes("review")) score += 18;
    if (normalized.includes("verify")) score += 17;
    if (normalized.includes("report")) score += 14;
    if (normalized.includes("status")) score += 12;
    if (normalized.includes("git")) score += 12;
    if (normalized.includes("security")) score += 20;
    if (normalized.includes("hardening")) score += 16;
    if (normalized.includes("autonomy")) score += 10;
  }

  for (const token of tokens) {
    if (token.length < 3) {
      continue;
    }

    if (normalized.includes(token)) {
      score += 3;
    }
  }

  if (CODE_EXTENSIONS.has(fileExtension(normalized))) {
    score += 2;
  }
  if (DOC_EXTENSIONS.has(fileExtension(normalized))) {
    score += 1;
  }

  return score;
}

function buildSystemAuditBlueprints(goal: GoalRecord, signals: RepoAwareProposalSignals): Array<{
  key: string;
  title: string;
  acceptance: string[];
  fileHints: string[];
}> {
  const controlHints = buildControlSurfaceHints(signals);
  const auditHints = selectTaskHints(signals.matched_paths, (pathValue) => isCodeLikePath(pathValue), 4);
  const docsHints = selectTaskHints(signals.documentation_paths, () => true, 3);
  const packageHints = signals.package_manifest_paths.slice(0, 2);
  const verifyHint = mergeHints(["scripts/verify.ps1", "scripts/review.ps1"], controlHints, auditHints);

  return [
    {
      key: "audit",
      title: "Audit the repo control surface and rank the highest-risk findings",
      acceptance: [
        `Review AGENTS.md, README/docs, package manifests, and the matched repo paths before changing code.`,
        `List the highest-risk issues for ${goal.objective}.`,
        `Call out whether each issue is safe to auto-fix or should be stopped as a blocker.`,
      ],
      fileHints: mergeHints(["AGENTS.md", "README.md"], packageHints, docsHints, controlHints, auditHints),
    },
    {
      key: "reproduce",
      title: "Reproduce the top issue with a minimal case",
      acceptance: [
        "Capture one minimal reproduction or a precise failing command.",
        "Tie the failure back to a concrete repo path or configuration surface.",
        "Avoid widening scope while proving the bug.",
      ],
      fileHints: mergeHints(verifyHint, auditHints, packageHints.slice(0, 1)),
    },
    {
      key: "repair",
      title: "Repair the narrowest root cause",
      acceptance: [
        "Fix the highest-priority issue with the smallest possible code change.",
        "Keep unrelated behavior stable.",
        "Escalate to a blocker instead of broadening scope if the repair needs a major decision.",
      ],
      fileHints: mergeHints(auditHints, controlHints, packageHints.slice(0, 1)),
    },
    {
      key: "verify",
      title: "Verify the fix and guard the regression",
      acceptance: [
        "Run scripts/verify.ps1 and any targeted regression tests for the repaired path.",
        "Confirm the change preserves the repo control surface contract.",
        "Record any remaining follow-up risk explicitly.",
      ],
      fileHints: mergeHints(["scripts/verify.ps1", "scripts/review.ps1"], selectTaskHints(signals.matched_paths, () => true, 3), selectTaskHints(signals.documentation_paths, () => true, 1)),
    },
    {
      key: "summarize",
      title: "Summarize residual risk and the next safe follow-up",
      acceptance: [
        "Write down the remaining risk, blocked decisions, and any safe next follow-up.",
        "Keep the summary bounded to the approved goal.",
        "Do not imply that a new major decision was approved.",
      ],
      fileHints: mergeHints(["README.md"], controlHints, docsHints),
    },
  ];
}

function buildGenericBlueprints(goal: GoalRecord, signals: RepoAwareProposalSignals): Array<{
  key: string;
  title: string;
  acceptance: string[];
  fileHints: string[];
}> {
  const controlHints = buildControlSurfaceHints(signals);
  const matchedCodeHints = selectTaskHints(signals.matched_paths, (pathValue) => isCodeLikePath(pathValue), 4);
  const regressionHints = selectTaskHints(signals.matched_paths, (pathValue) => isTestLikePath(pathValue), 3);
  const docsHints = selectTaskHints(signals.documentation_paths, () => true, 3);

  return [
    {
      key: "review",
      title: "Review the repo surfaces that shape the change",
      acceptance: [
        `Map ${goal.objective} against the repo control surface before editing code.`,
        "Catalog the relevant package scripts, docs, and matched files.",
        "Name the smallest file set that can satisfy the goal.",
      ],
      fileHints: mergeHints(controlHints, signals.package_manifest_paths, docsHints, matchedCodeHints),
    },
    {
      key: "implement",
      title: "Implement the smallest viable fix",
      acceptance: [
        "Change only the files required for the goal.",
        "Keep unrelated behavior unchanged.",
        "Escalate if the fix would require a new major decision.",
      ],
      fileHints: mergeHints(matchedCodeHints, controlHints),
    },
    {
      key: "regression",
      title: "Add focused regression coverage",
      acceptance: [
        "Add or update tests that fail before the fix and pass after it.",
        "Cover the exact path you changed.",
        "Avoid a broad test rewrite unless the goal demands it.",
      ],
      fileHints: mergeHints(regressionHints, matchedCodeHints, ["scripts/verify.ps1"]),
    },
    {
      key: "verify",
      title: "Verify the change and close out risk",
      acceptance: [
        "Run scripts/verify.ps1 and the narrowest targeted checks available.",
        "Confirm the result matches the original goal.",
        "Record any remaining follow-up as a bounded note, not a new scope expansion.",
      ],
      fileHints: mergeHints(["scripts/verify.ps1", "scripts/review.ps1"], regressionHints, docsHints),
    },
  ];
}

function finalizeBlueprints(goal: GoalRecord, blueprints: Array<{
  key: string;
  title: string;
  acceptance: string[];
  fileHints: string[];
}>): ProposedTask[] {
  return blueprints.slice(0, 5).map((blueprint, index) => ({
    id: buildProposalTaskId(goal.id, blueprint.key),
    title: blueprint.title,
    priority: index === 0 ? "P0" : index === 1 ? "P1" : "P2",
    depends_on: index === 0 ? [] : [buildProposalTaskId(goal.id, blueprints[index - 1]?.key ?? blueprint.key)],
    acceptance: dedupeStrings(blueprint.acceptance),
    file_hints: dedupeStrings(blueprint.fileHints).slice(0, 5),
  }));
}

function buildRepoAwareSummary(goal: GoalRecord, signals: RepoAwareProposalSignals, taskCount: number): string {
  const evidence: string[] = [];
  if (signals.agents_path) {
    evidence.push("AGENTS.md");
  }
  if (signals.package_manifest_paths.length > 0) {
    const scriptSummary = signals.package_script_names.length > 0
      ? `package scripts (${signals.package_script_names.slice(0, 4).join(", ")})`
      : `package manifests (${signals.package_manifest_paths.length})`;
    evidence.push(scriptSummary);
  }
  if (signals.documentation_paths.length > 0) {
    evidence.push(`README/docs (${signals.documentation_paths.length})`);
  }
  if (signals.matched_paths.length > 0) {
    evidence.push(`matched paths (${signals.matched_paths.length})`);
  }

  const goalLabel = signals.goal_style === "system_audit" ? "audit" : "fallback";
  const evidenceText = evidence.length > 0 ? evidence.join(", ") : "repo-local goal metadata";
  return `Repo-aware ${goalLabel} proposal for ${goal.id} grounded in ${evidenceText} and expanded into ${taskCount} task(s).`;
}

function buildControlSurfaceHints(signals: RepoAwareProposalSignals): string[] {
  const hints = [...CONTROL_SURFACE_HINTS];

  if (signals.agents_path && !hints.includes(signals.agents_path)) {
    hints.unshift(signals.agents_path);
  }

  for (const pathValue of CONTROL_SURFACE_PATH_HINTS) {
    if (!hints.includes(pathValue) && signals.matched_paths.includes(pathValue)) {
      hints.push(pathValue);
    }
  }

  return dedupeStrings(hints);
}

function selectTaskHints(paths: string[], predicate: (pathValue: string) => boolean, limit: number): string[] {
  return dedupeStrings(paths.filter(predicate)).slice(0, limit);
}

function mergeHints(...groups: string[][]): string[] {
  return dedupeStrings(groups.flat());
}

function isCodeLikePath(pathValue: string): boolean {
  return CODE_EXTENSIONS.has(fileExtension(pathValue)) || pathValue.startsWith("src/") || pathValue.startsWith("scripts/");
}

function isTestLikePath(pathValue: string): boolean {
  return pathValue.startsWith("test/") || pathValue.includes(".test.") || pathValue.includes(".spec.");
}

function extractGoalTokens(goalText: string): string[] {
  const matches = goalText.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(matches)].filter((token) => token.length >= 3);
}

function detectGoalStyle(goal: GoalRecord): "system_audit" | "generic" {
  const text = [
    goal.title,
    goal.objective,
    ...goal.success_criteria,
    ...goal.constraints,
    ...goal.out_of_scope,
  ].join(" ").toLowerCase();

  if (CHINESE_AUDIT_PHRASES.some((phrase) => text.includes(phrase.toLowerCase()))) {
    return "system_audit";
  }

  if (SYSTEM_AUDIT_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return "system_audit";
  }

  return "generic";
}

async function collectRepoFiles(repoRoot: string, maxDepth: number): Promise<RepoFileRecord[]> {
  const rootExists = await pathExists(repoRoot);
  if (!rootExists) {
    return [];
  }

  const files: RepoFileRecord[] = [];
  await walkDirectory(repoRoot, repoRoot, 0, maxDepth, files);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

async function walkDirectory(
  repoRoot: string,
  currentDir: string,
  depth: number,
  maxDepth: number,
  files: RepoFileRecord[],
): Promise<void> {
  if (depth > maxDepth) {
    return;
  }

  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") {
      continue;
    }

    if (entry.isDirectory() && shouldSkipDirectory(entry.name)) {
      continue;
    }

    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(repoRoot, absolutePath, depth + 1, maxDepth, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = relative(repoRoot, absolutePath).replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("..")) {
      continue;
    }

    files.push({
      absolutePath,
      relativePath,
    });
  }
}

function shouldSkipDirectory(directoryName: string): boolean {
  return IGNORED_DIRECTORIES.has(directoryName) || (directoryName.startsWith(".") && !VISIBLE_HIDDEN_DIRECTORIES.has(directoryName));
}

function fileExtension(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }

  return normalized.slice(dotIndex).toLowerCase();
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function buildProposalTaskId(goalId: string, key: string): string {
  return `proposal-${slugify(goalId)}-${key}`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug.length > 0 ? slug : "goal";
}
