import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import type { CommandResult } from "../contracts/autonomy.js";
import { isDirectory, pathExists, readTextFile, writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoPaths, resolveRepoRoot } from "../shared/paths.js";
import { runGraphifySnapshotCommand, type GraphifySnapshotResult } from "./graphify-snapshot.js";

const SCAN_PROFILES = ["source-only", "full"] as const;
type ScanProfile = (typeof SCAN_PROFILES)[number];

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
  "graphify-out",
  "node_modules",
  "out",
  "tmp",
  "venv",
]);

const DOC_FILE_NAMES = new Set([
  "README.md",
  "README.zh-CN.md",
  "TEAM_GUIDE.md",
  "AGENTS.md",
  "AGENTS.override.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "PERFORMANCE.md",
  "SECURITY.md",
]);

const ENTRY_FILE_NAMES = new Set([
  "app.js",
  "app.jsx",
  "app.py",
  "app.ts",
  "app.tsx",
  "index.js",
  "index.jsx",
  "index.ts",
  "index.tsx",
  "main.js",
  "main.jsx",
  "main.py",
  "main.ts",
  "main.tsx",
  "server.js",
  "server.ts",
]);

interface ScanOptions {
  target?: string;
  profile?: string;
  updateTeamGuide?: boolean;
}

interface ScanDependencies {
  runGraphifySnapshot?: (options: Parameters<typeof runGraphifySnapshotCommand>[0]) => Promise<GraphifySnapshotResult>;
  now?: () => Date;
}

interface PackageScriptSummary {
  path: string;
  scripts: string[];
}

interface RepoMapStack {
  languages: string[];
  frameworks: string[];
  package_managers: string[];
}

export interface RepoMapDocument {
  version: 1;
  generated_at: string;
  target_path: string;
  profile: ScanProfile;
  graphify: {
    graphify_out_path: string;
    graph_json_path: string;
    report_path: string;
    html_path: string;
    metrics: GraphifySnapshotResult["summary"]["metrics"];
  };
  stack: RepoMapStack;
  commands: {
    package_scripts: PackageScriptSummary[];
    verification_candidates: string[];
  };
  entrypoints: string[];
  docs: string[];
  hotspots: string[];
  known_risks: string[];
}

interface ScanSummary {
  target_path: string;
  profile: ScanProfile;
  repo_map_path: string;
  team_guide_path: string;
  team_guide_action: "updated" | "skipped";
  graphify_report_path: string;
  graphify_json_path: string;
  stack: RepoMapStack;
  package_script_count: number;
  entrypoint_count: number;
  doc_count: number;
  hotspot_count: number;
  known_risks: string[];
  next_steps: string[];
}

export interface ScanResult extends CommandResult {
  summary: ScanSummary;
}

export async function runScanCommand(
  options: ScanOptions = {},
  dependencies: ScanDependencies = {},
): Promise<ScanResult> {
  const targetInput = options.target?.trim() || process.cwd();
  const targetPath = resolveRepoRoot(targetInput);
  const profile = normalizeProfile(options.profile);

  if (!profile) {
    throw new CliError("scan requires --profile source-only|full.", CLI_EXIT_CODES.usage);
  }

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`Scan target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const runGraphifySnapshot = dependencies.runGraphifySnapshot ?? runGraphifySnapshotCommand;
  const graphifyResult = await runGraphifySnapshot({
    target: targetPath,
    profile,
    writeIgnore: false,
  });

  const repoMap = await buildRepoMap({
    targetPath,
    profile,
    graphifyResult,
    generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
  });
  const paths = resolveRepoPaths(targetPath);
  await writeJsonAtomic(paths.repoMapFile, repoMap);

  let teamGuideAction: ScanSummary["team_guide_action"] = "skipped";
  if (options.updateTeamGuide === true) {
    await writeTextFileAtomic(path.join(targetPath, "TEAM_GUIDE.md"), buildTeamGuideFromRepoMap(repoMap));
    teamGuideAction = "updated";
  }

  const warnings = [
    ...(graphifyResult.warnings ?? []),
    repoMap.docs.length === 0
      ? {
        code: "scan_docs_missing",
        message: "No standard source docs were detected. Treat the repo map as structural only.",
      }
      : null,
    repoMap.commands.verification_candidates.length === 0
      ? {
        code: "scan_verification_missing",
        message: "No obvious verification command or test entry was detected.",
      }
      : null,
  ].filter((warning): warning is { code: string; message: string } => warning !== null);

  return {
    ok: true,
    message: `Repo scan completed for ${targetPath}.`,
    summary: {
      target_path: targetPath,
      profile,
      repo_map_path: paths.repoMapFile,
      team_guide_path: path.join(targetPath, "TEAM_GUIDE.md"),
      team_guide_action: teamGuideAction,
      graphify_report_path: graphifyResult.summary.report_path,
      graphify_json_path: graphifyResult.summary.graph_json_path,
      stack: repoMap.stack,
      package_script_count: repoMap.commands.package_scripts.reduce((count, summary) => count + summary.scripts.length, 0),
      entrypoint_count: repoMap.entrypoints.length,
      doc_count: repoMap.docs.length,
      hotspot_count: repoMap.hotspots.length,
      known_risks: repoMap.known_risks,
      next_steps: [
        "Read autonomy/context/repo-map.json as a compact orientation artifact, not as authoritative code truth.",
        "Use graphify-out/GRAPH_REPORT.md for code-map pointers, then verify important conclusions in source.",
        "Run codex-autonomy query --json before automation, relay, scheduler, or UI consumers choose a next action.",
      ],
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .option("--target <path>", "Target repository root")
    .option("--profile <profile>", "Scan profile: source-only or full", "source-only")
    .option("--update-team-guide", "Refresh TEAM_GUIDE.md from the generated repo map")
    .description("Build a repo map by combining Graphify output with docs, scripts, entrypoints, and verification hints")
    .action(async (options: ScanOptions) => {
      const result = await runScanCommand(options);
      console.log(JSON.stringify(result, null, 2));
    });
}

async function buildRepoMap(options: {
  targetPath: string;
  profile: ScanProfile;
  graphifyResult: GraphifySnapshotResult;
  generatedAt: string;
}): Promise<RepoMapDocument> {
  const files = await collectFiles(options.targetPath, 4);
  const packageScripts = await collectPackageScripts(options.targetPath, files);
  const entrypoints = collectEntryCandidates(files);
  const docs = collectDocs(files);
  const verificationCandidates = collectVerificationCandidates(files, packageScripts);
  const stack = detectStack(files, packageScripts);
  const hotspots = collectHotspots(options.graphifyResult.summary.metrics.god_nodes, entrypoints);
  const knownRisks = buildKnownRisks({ docs, verificationCandidates, graphifyResult: options.graphifyResult });

  return {
    version: 1,
    generated_at: options.generatedAt,
    target_path: options.targetPath,
    profile: options.profile,
    graphify: {
      graphify_out_path: options.graphifyResult.summary.graphify_out_path,
      graph_json_path: options.graphifyResult.summary.graph_json_path,
      report_path: options.graphifyResult.summary.report_path,
      html_path: options.graphifyResult.summary.html_path,
      metrics: options.graphifyResult.summary.metrics,
    },
    stack,
    commands: {
      package_scripts: packageScripts,
      verification_candidates: verificationCandidates,
    },
    entrypoints,
    docs,
    hotspots,
    known_risks: knownRisks,
  };
}

async function collectFiles(repoRoot: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length >= 500) {
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
  return results.sort((left, right) => left.localeCompare(right));
}

async function collectPackageScripts(repoRoot: string, files: string[]): Promise<PackageScriptSummary[]> {
  const summaries: PackageScriptSummary[] = [];
  for (const file of files.filter((candidate) => path.basename(candidate) === "package.json")) {
    const parsed = await readJsonRecord(path.join(repoRoot, file));
    const scripts = asStringRecord(parsed?.scripts);
    if (!scripts) {
      continue;
    }

    summaries.push({
      path: file,
      scripts: Object.keys(scripts).sort((left, right) => left.localeCompare(right)),
    });
  }

  return summaries.sort((left, right) => left.path.localeCompare(right.path)).slice(0, 12);
}

function collectDocs(files: string[]): string[] {
  return files
    .filter((file) => DOC_FILE_NAMES.has(path.basename(file)) || /^docs\/.+\.md$/i.test(file))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 30);
}

function collectEntryCandidates(files: string[]): string[] {
  return files
    .filter((file) => ENTRY_FILE_NAMES.has(path.basename(file)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 24);
}

function collectVerificationCandidates(files: string[], packageScripts: PackageScriptSummary[]): string[] {
  const commands = new Set<string>();
  for (const summary of packageScripts) {
    for (const script of summary.scripts) {
      if (/test|verify|check|lint|smoke|e2e|build/i.test(script)) {
        const prefix = summary.path === "package.json"
          ? "npm run"
          : `npm --prefix ${path.dirname(summary.path).replace(/\\/g, "/")} run`;
        commands.add(`${prefix} ${script}`);
      }
    }
  }

  if (files.includes("scripts/verify.ps1")) {
    commands.add("pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1");
  }
  if (files.includes("pyproject.toml")) {
    commands.add("python -m pytest");
  }
  if (files.some((file) => /(^|\/)tests?\//i.test(file) && file.endsWith(".py"))) {
    commands.add("python -m pytest");
  }

  return [...commands].slice(0, 20);
}

function collectHotspots(godNodes: string[], entrypoints: string[]): string[] {
  return [...new Set([
    ...godNodes.map((node) => node.replace(/^(\d+)\.\s+/, "").trim()).filter(Boolean),
    ...entrypoints.slice(0, 8),
  ])].slice(0, 20);
}

function detectStack(files: string[], packageScripts: PackageScriptSummary[]): RepoMapStack {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();

  if (files.some((file) => /\.[cm]?[jt]sx?$/i.test(file))) {
    languages.add("javascript/typescript");
  }
  if (files.some((file) => file.endsWith(".py"))) {
    languages.add("python");
  }
  if (files.some((file) => file.endsWith(".ps1"))) {
    languages.add("powershell");
  }
  if (files.includes("package.json") || packageScripts.length > 0) {
    packageManagers.add("npm");
  }
  if (files.includes("pnpm-lock.yaml")) {
    packageManagers.add("pnpm");
  }
  if (files.includes("yarn.lock")) {
    packageManagers.add("yarn");
  }
  if (files.includes("pyproject.toml") || files.includes("requirements.txt")) {
    packageManagers.add("python");
  }
  if (files.some((file) => file.includes("vite.config."))) {
    frameworks.add("vite");
  }
  if (files.some((file) => file.includes("next.config."))) {
    frameworks.add("next");
  }
  if (files.some((file) => file.includes("playwright.config."))) {
    frameworks.add("playwright");
  }
  if (files.some((file) => /(^|\/)src\/.*\.(tsx|jsx)$/i.test(file))) {
    frameworks.add("react");
  }

  return {
    languages: [...languages].sort(),
    frameworks: [...frameworks].sort(),
    package_managers: [...packageManagers].sort(),
  };
}

function buildKnownRisks(options: {
  docs: string[];
  verificationCandidates: string[];
  graphifyResult: GraphifySnapshotResult;
}): string[] {
  const risks = [
    "Graphify output is an orientation map; verify important routing, API, and state conclusions in source.",
  ];

  if (options.docs.length === 0) {
    risks.push("No standard docs were detected; create or refresh TEAM_GUIDE.md before unattended work.");
  }
  if (options.verificationCandidates.length === 0) {
    risks.push("No obvious verification command was detected; define a repo-local verification gate before long-running autonomy.");
  }
  if (options.graphifyResult.warnings?.some((warning) => warning.code === "graphify_html_missing")) {
    risks.push("Graphify HTML output is missing; use the markdown report and graph.json as the primary map.");
  }

  return risks;
}

function buildTeamGuideFromRepoMap(repoMap: RepoMapDocument): string {
  return [
    "# TEAM_GUIDE",
    "",
    `Generated by \`codex-autonomy scan --profile ${repoMap.profile} --update-team-guide\` at ${repoMap.generated_at}.`,
    "This is a compact current-state snapshot, not a changelog. Keep it short and refresh it only after durable project changes.",
    "",
    "## 1. Project Map",
    "",
    `- Target path: ${repoMap.target_path}.`,
    `- Stack: ${formatInlineList([...repoMap.stack.languages, ...repoMap.stack.frameworks])}.`,
    `- Repo map: autonomy/context/repo-map.json.`,
    `- Graphify report: ${path.relative(repoMap.target_path, repoMap.graphify.report_path).replace(/\\/g, "/")}.`,
    "",
    "## 2. Entry Points And Hotspots",
    "",
    "- Likely entrypoints:",
    ...formatList(repoMap.entrypoints, "No obvious entrypoints detected."),
    "- Hotspots:",
    ...formatList(repoMap.hotspots, "No hotspots detected in the available map."),
    "",
    "## 3. Run And Verification Commands",
    "",
    "- Package scripts:",
    ...formatPackageScriptLines(repoMap.commands.package_scripts),
    "- Verification candidates:",
    ...formatList(repoMap.commands.verification_candidates, "No obvious verification commands detected."),
    "",
    "## 4. Source Docs",
    "",
    ...formatList(repoMap.docs, "No standard source docs detected."),
    "",
    "## 5. Current Risks / Known Unknowns",
    "",
    ...formatList(repoMap.known_risks, "No scan risks recorded."),
  ].join("\n");
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  try {
    const value = JSON.parse(await readTextFile(filePath)) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeProfile(value: string | undefined): ScanProfile | null {
  if (value === "source-only" || value === "full") {
    return value;
  }

  return null;
}

function formatInlineList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "not detected";
}

function formatList(items: string[], emptyMessage: string): string[] {
  if (items.length === 0) {
    return [`- ${emptyMessage}`];
  }

  return items.map((item) => `- ${item}`);
}

function formatPackageScriptLines(items: PackageScriptSummary[]): string[] {
  if (items.length === 0) {
    return ["- No package scripts detected."];
  }

  return items.flatMap((summary) => [
    `- ${summary.path}`,
    ...summary.scripts.map((script) => `  - npm run ${script}`),
  ]);
}
