import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import type { CommandResult } from "../contracts/autonomy.js";
import { isDirectory, pathExists, readTextFile, writeTextFileAtomic } from "../infra/fs.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoRoot } from "../shared/paths.js";
import { runInstallCommand } from "./install.js";

const execFileAsync = promisify(execFile);
const INIT_PROJECT_MODES = ["existing", "new"] as const;
type InitProjectMode = (typeof INIT_PROJECT_MODES)[number];

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".agents",
  ".codex",
  ".next",
  ".turbo",
  ".venv",
  "autonomy",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "tmp",
  "venv",
]);

const DOC_FILE_NAMES = new Set([
  "README.md",
  "README.zh-CN.md",
  "DESIGN.md",
  "ARCHITECTURE.md",
  "SECURITY.md",
  "PERFORMANCE.md",
  "CONTRIBUTING.md",
]);

const ENTRY_FILE_NAMES = new Set([
  "main.ts",
  "main.tsx",
  "main.js",
  "main.jsx",
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "app.ts",
  "app.tsx",
  "app.js",
  "app.jsx",
  "server.ts",
  "server.js",
  "main.py",
  "app.py",
]);

interface InitProjectOptions {
  target?: string;
  mode?: string;
  refreshDocs?: boolean;
  skipInstall?: boolean;
}

interface InitProjectDependencies {
  installDependencies?: Parameters<typeof runInstallCommand>[1];
  now?: () => Date;
}

interface PackageScriptSummary {
  path: string;
  scripts: string[];
}

interface ProjectSnapshot {
  title: string;
  summary: string | null;
  topLevelDirectories: string[];
  topLevelFiles: string[];
  packageScripts: PackageScriptSummary[];
  docs: string[];
  entryCandidates: string[];
  testCandidates: string[];
}

interface InitProjectSummary {
  target_path: string;
  mode: InitProjectMode;
  install_ran: boolean;
  install_ok: boolean | null;
  created_paths: string[];
  refreshed_paths: string[];
  skipped_paths: string[];
  team_guide_path: string;
  agents_override_path: string;
  next_steps: string[];
}

export interface InitProjectResult extends CommandResult {
  summary: InitProjectSummary;
}

export async function runInitProjectCommand(
  options: InitProjectOptions = {},
  dependencies: InitProjectDependencies = {},
): Promise<InitProjectResult> {
  const targetInput = options.target?.trim() || process.cwd();
  const targetPath = resolveRepoRoot(targetInput);
  const mode = normalizeMode(options.mode);
  const refreshDocs = options.refreshDocs === true;
  const skipInstall = options.skipInstall === true;

  if (!mode) {
    throw new CliError("init-project requires --mode existing|new.", CLI_EXIT_CODES.usage);
  }

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`Project init target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const originalRepoRoot = await resolveInitialRepoRoot(targetPath, dependencies);
  const snapshot = await collectProjectSnapshot(originalRepoRoot);

  const installResult = skipInstall
    ? null
    : await runInstallCommand({ target: targetPath }, dependencies.installDependencies);

  if (installResult && !installResult.ok) {
    return {
      ok: false,
      message: `Project init blocked because control-surface install failed: ${installResult.message}`,
      summary: {
        target_path: installResult.summary.target_path,
        mode,
        install_ran: true,
        install_ok: false,
        created_paths: [],
        refreshed_paths: [],
        skipped_paths: [],
        team_guide_path: path.join(installResult.summary.target_path, "TEAM_GUIDE.md"),
        agents_override_path: path.join(installResult.summary.target_path, "AGENTS.override.md"),
        next_steps: [
          "Resolve the install blocker, then rerun codex-autonomy init-project.",
        ],
      },
      warnings: installResult.warnings,
    };
  }

  const repoRoot = installResult?.summary.target_path ?? originalRepoRoot;
  const now = dependencies.now?.() ?? new Date();
  const teamGuidePath = path.join(repoRoot, "TEAM_GUIDE.md");
  const agentsOverridePath = path.join(repoRoot, "AGENTS.override.md");
  const createdPaths: string[] = [];
  const refreshedPaths: string[] = [];
  const skippedPaths: string[] = [];

  await writeProjectDoc({
    filePath: teamGuidePath,
    content: buildTeamGuideMarkdown({
      mode,
      snapshot,
      generatedAt: now.toISOString(),
    }),
    refresh: refreshDocs,
    createdPaths,
    refreshedPaths,
    skippedPaths,
  });

  await writeProjectDoc({
    filePath: agentsOverridePath,
    content: buildAgentsOverrideMarkdown(),
    refresh: refreshDocs,
    createdPaths,
    refreshedPaths,
    skippedPaths,
  });

  const nextSteps = [
    "Review TEAM_GUIDE.md and tighten any project-specific commands or risks.",
    "Run pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1 in the target repo.",
    "Run codex-autonomy doctor, then codex-autonomy prepare-worktree when the target is a clean Git repo.",
    "Start work from natural language: 目标是……, 确认提案, 确认提案并继续.",
  ];

  return {
    ok: true,
    message: `Project init completed for ${repoRoot}. TEAM_GUIDE.md is ${createdPaths.includes(teamGuidePath) ? "created" : refreshedPaths.includes(teamGuidePath) ? "refreshed" : "left untouched"}.`,
    summary: {
      target_path: repoRoot,
      mode,
      install_ran: !skipInstall,
      install_ok: installResult?.ok ?? null,
      created_paths: createdPaths,
      refreshed_paths: refreshedPaths,
      skipped_paths: skippedPaths,
      team_guide_path: teamGuidePath,
      agents_override_path: agentsOverridePath,
      next_steps: nextSteps,
    },
    warnings: buildInitWarnings({
      installWarnings: installResult?.warnings,
      skippedPaths,
      refreshDocs,
    }),
  };
}

async function resolveInitialRepoRoot(
  targetPath: string,
  dependencies: InitProjectDependencies,
): Promise<string> {
  const injectedDetector = dependencies.installDependencies?.detectGitTopLevel;
  const detected = await (injectedDetector ?? resolveGitTopLevel)(targetPath);
  return detected ?? targetPath;
}

async function resolveGitTopLevel(targetPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetPath, "rev-parse", "--show-toplevel"]);
    const output = stdout.trim();
    return output.length > 0 ? path.resolve(output) : null;
  } catch {
    return null;
  }
}

export function registerInitProjectCommand(program: Command): void {
  program
    .command("init-project")
    .option("--target <path>", "Target repository root")
    .option("--mode <mode>", "Project mode: existing or new", "existing")
    .option("--refresh-docs", "Regenerate TEAM_GUIDE.md and AGENTS.override.md if they already exist")
    .option("--skip-install", "Only create project docs; do not install or refresh the control surface")
    .description("Install the control surface and create a compact project baseline for a target repository")
    .action(async (options: InitProjectOptions) => {
      const result = await runInitProjectCommand(options);
      console.log(JSON.stringify(result, null, 2));
    });
}

function normalizeMode(value: string | undefined): InitProjectMode | null {
  if (value === "existing" || value === "new") {
    return value;
  }

  return null;
}

async function writeProjectDoc(options: {
  filePath: string;
  content: string;
  refresh: boolean;
  createdPaths: string[];
  refreshedPaths: string[];
  skippedPaths: string[];
}): Promise<void> {
  const exists = await pathExists(options.filePath);
  if (exists && !options.refresh) {
    options.skippedPaths.push(options.filePath);
    return;
  }

  await writeTextFileAtomic(options.filePath, `${options.content}\n`);
  if (exists) {
    options.refreshedPaths.push(options.filePath);
  } else {
    options.createdPaths.push(options.filePath);
  }
}

async function collectProjectSnapshot(repoRoot: string): Promise<ProjectSnapshot> {
  const [topLevelEntries, docs, packageScripts, entryCandidates, testCandidates] = await Promise.all([
    collectTopLevelEntries(repoRoot),
    collectDocs(repoRoot),
    collectPackageScripts(repoRoot),
    collectEntryCandidates(repoRoot),
    collectTestCandidates(repoRoot),
  ]);
  const readmeSummary = await readReadmeSummary(repoRoot);

  return {
    title: readmeSummary.title ?? path.basename(repoRoot),
    summary: readmeSummary.summary,
    topLevelDirectories: topLevelEntries.directories,
    topLevelFiles: topLevelEntries.files,
    packageScripts,
    docs,
    entryCandidates,
    testCandidates,
  };
}

async function collectTopLevelEntries(repoRoot: string): Promise<{ directories: string[]; files: string[] }> {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  const directories: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        directories.push(`${entry.name}/`);
      }
      continue;
    }

    if (entry.isFile() && !entry.name.endsWith(".log")) {
      files.push(entry.name);
    }
  }

  return {
    directories: directories.sort((left, right) => left.localeCompare(right)).slice(0, 18),
    files: files.sort((left, right) => left.localeCompare(right)).slice(0, 18),
  };
}

async function collectDocs(repoRoot: string): Promise<string[]> {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && DOC_FILE_NAMES.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function collectPackageScripts(repoRoot: string): Promise<PackageScriptSummary[]> {
  const files = await collectFiles(repoRoot, 3);
  const packageJsonFiles = files.filter((file) => path.basename(file) === "package.json");
  const summaries: PackageScriptSummary[] = [];

  for (const file of packageJsonFiles) {
    try {
      const parsed = JSON.parse(await readTextFile(path.join(repoRoot, file))) as { scripts?: Record<string, unknown> };
      const scripts = Object.keys(parsed.scripts ?? {}).sort((left, right) => left.localeCompare(right));
      summaries.push({ path: file, scripts });
    } catch {
      continue;
    }
  }

  return summaries.sort((left, right) => left.path.localeCompare(right.path)).slice(0, 8);
}

async function collectEntryCandidates(repoRoot: string): Promise<string[]> {
  const files = await collectFiles(repoRoot, 4);
  return files
    .filter((file) => ENTRY_FILE_NAMES.has(path.basename(file)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 16);
}

async function collectTestCandidates(repoRoot: string): Promise<string[]> {
  const files = await collectFiles(repoRoot, 4);
  return files
    .filter((file) => /(^|\/)(test|tests|e2e|spec)(\/|$)/i.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 16);
}

async function collectFiles(repoRoot: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length >= 300) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(repoRoot, absolutePath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(absolutePath, depth + 1);
        }
        continue;
      }

      if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  }

  await visit(repoRoot, 0);
  return results;
}

async function readReadmeSummary(repoRoot: string): Promise<{ title: string | null; summary: string | null }> {
  const readmePath = path.join(repoRoot, "README.md");
  if (!(await pathExists(readmePath))) {
    return { title: null, summary: null };
  }

  const content = await readTextFile(readmePath);
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("<!--"));
  const title = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() ?? null;
  const summary = lines.find((line) => !line.startsWith("#") && !line.startsWith("[") && !line.startsWith("!")) ?? null;
  return { title, summary };
}

function buildTeamGuideMarkdown(options: {
  mode: InitProjectMode;
  snapshot: ProjectSnapshot;
  generatedAt: string;
}): string {
  const modeLabel = options.mode === "new" ? "new project" : "existing project";
  const packageScriptLines = options.snapshot.packageScripts.length > 0
    ? options.snapshot.packageScripts.flatMap((summary) => [
      `- ${summary.path}`,
      ...summary.scripts.map((script) => `  - npm run ${script}`),
    ])
    : ["- No package scripts detected yet."];

  return [
    "# TEAM_GUIDE",
    "",
    `Generated by \`codex-autonomy init-project --mode ${options.mode}\` at ${options.generatedAt}.`,
    "This is a compact current-state snapshot, not a changelog. Keep it short and refresh it only after durable project changes.",
    "",
    "## 1. Project Goal",
    "",
    `- Baseline type: ${modeLabel}.`,
    `- Project title: ${options.snapshot.title}.`,
    `- Current summary: ${options.snapshot.summary ?? "TBD. Fill this in after the product goal is clear."}`,
    "",
    "## 2. Current Architecture / Key Paths",
    "",
    "- Top-level directories:",
    ...formatList(options.snapshot.topLevelDirectories, "No app directories detected yet."),
    "- Top-level files:",
    ...formatList(options.snapshot.topLevelFiles, "No top-level files detected yet."),
    "- Likely entrypoints:",
    ...formatList(options.snapshot.entryCandidates, "No obvious entrypoints detected yet."),
    "- Likely tests:",
    ...formatList(options.snapshot.testCandidates, "No obvious test files detected yet."),
    "",
    "## 3. Run And Verification Commands",
    "",
    "- Package scripts:",
    ...packageScriptLines,
    "- Codex autonomy gate:",
    "  - pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1",
    "  - codex-autonomy doctor",
    "  - codex-autonomy prepare-worktree",
    "",
    "## 4. Key Integrations And Agent Conventions",
    "",
    "- `codex-autonomy` owns `autonomy/*`, repo-local `$autonomy-*` skills, and the bounded worker/review loop.",
    "- Use Playwright for reproducible project browser testing.",
    "- Use current-browser tooling only when the operator explicitly asks to use an already logged-in browser session.",
    "- For complex features or high-risk bug fixes, create a short `specs/<goal-id>/` packet before implementation.",
    "",
    "## 5. Current Risks / Known Unknowns",
    "",
    "- This baseline was generated from repository structure and should be reviewed once by a human/operator.",
    "- Confirm project-specific build, test, environment, and secret-handling requirements before enabling unattended work.",
    "- Keep destructive operations, credential changes, releases, and external paid-service side effects outside automation unless explicitly approved.",
    "",
    "## 6. Last Major Change Summary",
    "",
    `- ${options.generatedAt}: Created initial project baseline for ${modeLabel}.`,
    "- After medium or large changes, run a doc-impact check and update this file only when durable project facts changed.",
    "",
    "## Source Docs",
    "",
    ...formatList(options.snapshot.docs, "No standard source docs detected yet."),
  ].join("\n");
}

function buildAgentsOverrideMarkdown(): string {
  return [
    "# AGENTS.override.md",
    "",
    "Thin project overlay for stable human-maintained guidance.",
    "",
    "- Read `TEAM_GUIDE.md` before non-trivial planning, implementation, review, or automation continuation.",
    "- Keep durable project facts in `TEAM_GUIDE.md`; keep task logs, temporary findings, and transient decisions out of this file.",
    "- Use repo-local `AGENTS.md` and `$autonomy-*` skills as the control-plane rules when `codex-autonomy` is installed.",
    "- Use `scripts/verify.ps1` as the autonomy worker gate, then add the narrowest project-specific checks listed in `TEAM_GUIDE.md`.",
    "- For complex features, risky bug fixes, API/config/data-model changes, or multi-module work, create or update a compact `specs/<goal-id>/` packet before implementation.",
    "- At closeout, run doc-impact check: update `TEAM_GUIDE.md` only when commands, architecture, integrations, public config/API, permissions, verification, or long-lived risks changed.",
    "- Do not expand an approved autonomy goal without recording a blocker and asking the operator.",
  ].join("\n");
}

function formatList(items: string[], emptyMessage: string): string[] {
  if (items.length === 0) {
    return [`  - ${emptyMessage}`];
  }

  return items.map((item) => `  - ${item}`);
}

function buildInitWarnings(options: {
  installWarnings: CommandResult["warnings"] | undefined;
  skippedPaths: string[];
  refreshDocs: boolean;
}): CommandResult["warnings"] | undefined {
  const warnings = [
    ...(options.installWarnings ?? []),
    ...options.skippedPaths.map((skippedPath) => ({
      code: "project_doc_exists",
      message: `${skippedPath} already exists and was left untouched. Use --refresh-docs to regenerate it.`,
    })),
    !options.refreshDocs && options.skippedPaths.length > 0
      ? {
        code: "project_docs_not_refreshed",
        message: "Existing project docs were preserved by default.",
      }
      : null,
  ].filter((warning): warning is { code: string; message: string } => warning !== null);

  return warnings.length > 0 ? warnings : undefined;
}
