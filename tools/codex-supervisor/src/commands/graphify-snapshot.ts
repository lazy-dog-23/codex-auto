import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import type { CommandResult } from "../contracts/autonomy.js";
import { ensureParentDirectory, isDirectory, pathExists, readTextFile, writeTextFileAtomic } from "../infra/fs.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoRoot } from "../shared/paths.js";

const execFileAsync = promisify(execFile);
const GRAPHIFY_PROFILES = ["source-only", "full"] as const;
type GraphifyProfile = (typeof GRAPHIFY_PROFILES)[number];

const GRAPHIFY_IGNORE_START = "# BEGIN codex-autonomy graphify-snapshot";
const GRAPHIFY_IGNORE_END = "# END codex-autonomy graphify-snapshot";

interface GraphifySnapshotOptions {
  target?: string;
  profile?: string;
  refreshIgnore?: boolean;
  writeIgnore?: boolean;
  toolDir?: string;
  python?: string;
  skipInstall?: boolean;
}

interface GraphifyToolInfo {
  pythonPath: string;
  toolDir: string;
  packageInstalled: boolean;
}

interface GraphifyRunResult {
  stdout: string;
  stderr: string;
}

interface GraphifySnapshotDependencies {
  ensureTool?: (options: {
    toolDir: string;
    python?: string;
    skipInstall: boolean;
  }) => Promise<GraphifyToolInfo>;
  runUpdate?: (options: {
    pythonPath: string;
    targetPath: string;
  }) => Promise<GraphifyRunResult>;
  now?: () => Date;
}

interface GraphifyReportMetrics {
  files: number | null;
  approximate_words: number | null;
  nodes: number | null;
  edges: number | null;
  communities: number | null;
  extraction_summary: string | null;
  god_nodes: string[];
}

interface GraphifySnapshotSummary {
  target_path: string;
  profile: GraphifyProfile;
  tool_dir: string;
  helper_python: string;
  package_installed: boolean;
  ignore_path: string;
  ignore_action: "created" | "updated" | "preserved" | "skipped";
  graphify_out_path: string;
  graph_json_path: string;
  report_path: string;
  html_path: string;
  elapsed_ms: number;
  metrics: GraphifyReportMetrics;
  next_steps: string[];
}

export interface GraphifySnapshotResult extends CommandResult {
  summary: GraphifySnapshotSummary;
}

export async function runGraphifySnapshotCommand(
  options: GraphifySnapshotOptions = {},
  dependencies: GraphifySnapshotDependencies = {},
): Promise<GraphifySnapshotResult> {
  const targetInput = options.target?.trim() || process.cwd();
  const targetPath = resolveRepoRoot(targetInput);
  const profile = normalizeProfile(options.profile);
  const writeIgnore = options.writeIgnore !== false;
  const refreshIgnore = options.refreshIgnore === true;
  const skipInstall = options.skipInstall === true;
  const toolDir = path.resolve(options.toolDir?.trim() || path.join(os.homedir(), ".codex", "tools", "graphify"));

  if (!profile) {
    throw new CliError("graphify-snapshot requires --profile source-only|full.", CLI_EXIT_CODES.usage);
  }

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`Graphify target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const ensureTool = dependencies.ensureTool ?? ensureGraphifyTool;
  const runUpdate = dependencies.runUpdate ?? runGraphifyUpdate;
  const tool = await ensureTool({
    toolDir,
    python: options.python,
    skipInstall,
  });

  const ignorePath = path.join(targetPath, ".graphifyignore");
  const graphifyOutPath = path.join(targetPath, "graphify-out");
  const graphJsonPath = path.join(graphifyOutPath, "graph.json");
  const reportPath = path.join(graphifyOutPath, "GRAPH_REPORT.md");
  const htmlPath = path.join(graphifyOutPath, "graph.html");
  const ignoreSnapshot = writeIgnore ? await readOptionalTextFile(ignorePath) : null;
  const graphifyOutExisted = await pathExists(graphifyOutPath);

  let ignoreAction: GraphifySnapshotSummary["ignore_action"] = "skipped";
  let update: GraphifyRunResult;
  const start = Date.now();
  try {
    ignoreAction = writeIgnore
      ? await upsertGraphifyIgnore({ ignorePath, profile, refresh: refreshIgnore })
      : "skipped";

    update = await runUpdate({
      pythonPath: tool.pythonPath,
      targetPath,
    });

    await assertRequiredGraphifyOutputs({ reportPath, graphJsonPath });
  } catch (error) {
    if (writeIgnore && ignoreSnapshot) {
      await restoreGraphifyIgnore(ignorePath, ignoreSnapshot);
    }

    if (!graphifyOutExisted) {
      await fs.rm(graphifyOutPath, { recursive: true, force: true });
    }

    throw error;
  }
  const elapsedMs = Date.now() - start;

  const metrics = await readGraphifyMetrics(reportPath);
  const warnings = await buildGraphifyWarnings({
    ignoreAction,
    writeIgnore,
    stderr: update.stderr,
    reportPath,
    graphJsonPath,
    htmlPath,
  });

  return {
    ok: true,
    message: `Graphify snapshot completed for ${targetPath}.`,
    summary: {
      target_path: targetPath,
      profile,
      tool_dir: tool.toolDir,
      helper_python: tool.pythonPath,
      package_installed: tool.packageInstalled,
      ignore_path: ignorePath,
      ignore_action: ignoreAction,
      graphify_out_path: graphifyOutPath,
      graph_json_path: graphJsonPath,
      report_path: reportPath,
      html_path: htmlPath,
      elapsed_ms: elapsedMs,
      metrics,
      next_steps: [
        "Read graphify-out/GRAPH_REPORT.md as an orientation map, not as authoritative code truth.",
        "Use graphify query/path/explain only as a pointer to files and symbols; verify important conclusions in source.",
        "Do not install Graphify Codex hooks unless the operator explicitly chooses that workflow.",
      ],
    },
    warnings,
  };
}

export function registerGraphifySnapshotCommand(program: Command): void {
  program
    .command("graphify-snapshot")
    .option("--target <path>", "Target repository root")
    .option("--profile <profile>", "Snapshot profile: source-only or full", "source-only")
    .option("--refresh-ignore", "Refresh the codex-autonomy block in .graphifyignore")
    .option("--no-write-ignore", "Do not create or update .graphifyignore")
    .option("--tool-dir <path>", "Shared helper tool directory", path.join(os.homedir(), ".codex", "tools", "graphify"))
    .option("--python <path>", "Python launcher or executable used to create the helper venv")
    .option("--skip-install", "Do not install graphifyy if the helper environment is missing it")
    .description("Build a local Graphify code snapshot without installing Codex hooks or editing AGENTS.md")
    .action(async (options: GraphifySnapshotOptions) => {
      const result = await runGraphifySnapshotCommand(options);
      console.log(JSON.stringify(result, null, 2));
    });
}

function normalizeProfile(value: string | undefined): GraphifyProfile | null {
  if (value === "source-only" || value === "full") {
    return value;
  }

  return null;
}

async function readOptionalTextFile(filePath: string): Promise<{ exists: boolean; content: string }> {
  if (!(await pathExists(filePath))) {
    return { exists: false, content: "" };
  }

  return {
    exists: true,
    content: await readTextFile(filePath),
  };
}

async function restoreGraphifyIgnore(
  ignorePath: string,
  snapshot: { exists: boolean; content: string },
): Promise<void> {
  if (snapshot.exists) {
    await writeTextFileAtomic(ignorePath, snapshot.content);
    return;
  }

  await fs.rm(ignorePath, { force: true });
}

async function upsertGraphifyIgnore(options: {
  ignorePath: string;
  profile: GraphifyProfile;
  refresh: boolean;
}): Promise<GraphifySnapshotSummary["ignore_action"]> {
  const block = buildGraphifyIgnoreBlock(options.profile);
  const exists = await pathExists(options.ignorePath);
  const existing = exists ? await readTextFile(options.ignorePath) : "";

  if (existing.includes(GRAPHIFY_IGNORE_START) && existing.includes(GRAPHIFY_IGNORE_END)) {
    if (!options.refresh) {
      return "preserved";
    }

    const pattern = new RegExp(`${escapeRegExp(GRAPHIFY_IGNORE_START)}[\\s\\S]*?${escapeRegExp(GRAPHIFY_IGNORE_END)}`);
    await writeTextFileAtomic(options.ignorePath, `${existing.replace(pattern, block).trimEnd()}\n`);
    return "updated";
  }

  const nextContent = existing.trim().length > 0
    ? `${existing.trimEnd()}\n\n${block}\n`
    : `${block}\n`;
  await writeTextFileAtomic(options.ignorePath, nextContent);
  return exists ? "updated" : "created";
}

function buildGraphifyIgnoreBlock(profile: GraphifyProfile): string {
  const commonPatterns = [
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    "coverage/",
    ".venv/",
    ".venv-tools/",
    ".env",
    "*.log",
    "graphify-out/",
  ];
  const sourceOnlyPatterns = [
    ".agents/",
    ".codex/",
    "autonomy/",
    "tests/",
    "frontend/e2e/",
    "frontend/src/**/*.test.ts",
    "frontend/src/**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "scripts/",
    "docs/",
    "design-system/",
  ];
  const patterns = profile === "source-only"
    ? [...commonPatterns, ...sourceOnlyPatterns]
    : commonPatterns;

  return [
    GRAPHIFY_IGNORE_START,
    `# profile: ${profile}`,
    "# Maintained by codex-autonomy graphify-snapshot. Safe to edit if this repo needs different graph boundaries.",
    ...patterns,
    GRAPHIFY_IGNORE_END,
  ].join("\n");
}

async function ensureGraphifyTool(options: {
  toolDir: string;
  python?: string;
  skipInstall: boolean;
}): Promise<GraphifyToolInfo> {
  const venvDir = path.join(options.toolDir, ".venv");
  const pythonPath = path.join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const pythonLauncher = options.python?.trim() || (process.platform === "win32" ? "py" : "python3");

  if (!(await pathExists(pythonPath))) {
    if (options.skipInstall) {
      throw new CliError(`Graphify helper venv is missing: ${pythonPath}`, CLI_EXIT_CODES.validation);
    }

    await ensureParentDirectory(pythonPath);
    await execFileAsync(pythonLauncher, ["-m", "venv", venvDir], { maxBuffer: 10 * 1024 * 1024 });
  }

  const hasPackage = await canRunGraphify(pythonPath);
  if (!hasPackage) {
    if (options.skipInstall) {
      throw new CliError("graphifyy is not installed in the helper environment.", CLI_EXIT_CODES.validation);
    }

    await execFileAsync(pythonPath, ["-m", "pip", "install", "--upgrade", "pip"], { maxBuffer: 10 * 1024 * 1024 });
    await execFileAsync(pythonPath, ["-m", "pip", "install", "graphifyy"], { maxBuffer: 20 * 1024 * 1024 });
  }

  return {
    pythonPath,
    toolDir: options.toolDir,
    packageInstalled: !hasPackage,
  };
}

async function canRunGraphify(pythonPath: string): Promise<boolean> {
  try {
    await execFileAsync(pythonPath, ["-m", "graphify", "--help"], { maxBuffer: 2 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function runGraphifyUpdate(options: {
  pythonPath: string;
  targetPath: string;
}): Promise<GraphifyRunResult> {
  try {
    const result = await execFileAsync(
      options.pythonPath,
      ["-m", "graphify", "update", "."],
      {
        cwd: options.targetPath,
        timeout: 10 * 60 * 1000,
        maxBuffer: 30 * 1024 * 1024,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`graphify update failed: ${message}`, CLI_EXIT_CODES.validation);
  }
}

async function assertRequiredGraphifyOutputs(options: {
  reportPath: string;
  graphJsonPath: string;
}): Promise<void> {
  const missing = [];
  if (!(await pathExists(options.reportPath))) {
    missing.push(options.reportPath);
  }
  if (!(await pathExists(options.graphJsonPath))) {
    missing.push(options.graphJsonPath);
  }

  if (missing.length > 0) {
    throw new CliError(
      `graphify update completed but required output is missing: ${missing.join(", ")}`,
      CLI_EXIT_CODES.validation,
    );
  }
}

async function readGraphifyMetrics(reportPath: string): Promise<GraphifyReportMetrics> {
  if (!(await pathExists(reportPath))) {
    return emptyMetrics();
  }

  const report = await readTextFile(reportPath);
  const lines = report.split(/\r?\n/);
  const corpusLine = lines.find((line) => /^- [\d,]+ files/.test(line));
  const summaryLine = lines.find((line) => /^- [\d,]+ nodes/.test(line));
  const extractionLine = lines.find((line) => line.startsWith("- Extraction:")) ?? null;

  return {
    files: parseFirstNumber(corpusLine),
    approximate_words: parseApproximateWords(corpusLine),
    nodes: parseFirstNumber(summaryLine),
    edges: parseNumberAfter(summaryLine, "nodes"),
    communities: parseNumberAfter(summaryLine, "edges"),
    extraction_summary: extractionLine,
    god_nodes: parseGodNodes(lines),
  };
}

function emptyMetrics(): GraphifyReportMetrics {
  return {
    files: null,
    approximate_words: null,
    nodes: null,
    edges: null,
    communities: null,
    extraction_summary: null,
    god_nodes: [],
  };
}

function parseFirstNumber(line: string | undefined): number | null {
  const match = line?.match(/([\d,]+)/);
  return match?.[1] ? Number(match[1].replace(/,/g, "")) : null;
}

function parseApproximateWords(line: string | undefined): number | null {
  const match = line?.match(/~([\d,]+)\s+words/);
  return match?.[1] ? Number(match[1].replace(/,/g, "")) : null;
}

function parseNumberAfter(line: string | undefined, label: string): number | null {
  const match = line?.match(new RegExp(`${label}\\D+([\\d,]+)`));
  return match?.[1] ? Number(match[1].replace(/,/g, "")) : null;
}

function parseGodNodes(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.startsWith("## God Nodes"));
  if (start < 0) {
    return [];
  }

  const nodes: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }

    if (/^\d+\.\s+`/.test(line)) {
      nodes.push(line.trim());
    }

    if (nodes.length >= 10) {
      break;
    }
  }

  return nodes;
}

async function buildGraphifyWarnings(options: {
  ignoreAction: GraphifySnapshotSummary["ignore_action"];
  writeIgnore: boolean;
  stderr: string;
  reportPath: string;
  graphJsonPath: string;
  htmlPath: string;
}): Promise<CommandResult["warnings"] | undefined> {
  const warnings = [];

  if (!options.writeIgnore) {
    warnings.push({
      code: "graphify_ignore_skipped",
      message: ".graphifyignore was not created or updated; snapshot boundaries depend on existing project ignores.",
    });
  } else if (options.ignoreAction === "updated") {
    warnings.push({
      code: "graphify_ignore_updated",
      message: ".graphifyignore was updated with the codex-autonomy Graphify block.",
    });
  }

  for (const [code, filePath] of [
    ["graphify_report_missing", options.reportPath],
    ["graphify_json_missing", options.graphJsonPath],
    ["graphify_html_missing", options.htmlPath],
  ] as const) {
    if (!(await pathExists(filePath))) {
      warnings.push({
        code,
        message: `Expected Graphify output is missing: ${filePath}`,
      });
    }
  }

  if (options.stderr.trim().length > 0) {
    warnings.push({
      code: "graphify_stderr",
      message: options.stderr.trim().slice(0, 1000),
    });
  }

  return warnings.length > 0 ? warnings : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
