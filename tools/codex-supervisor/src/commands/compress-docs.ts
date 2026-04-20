import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import type { CommandResult, CommandWarning } from "../contracts/autonomy.js";
import { isDirectory, isFile, readTextFile, writeTextFileAtomic } from "../infra/fs.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoRoot } from "../shared/paths.js";

interface CompressDocsOptions {
  target?: string;
  check?: boolean;
  write?: boolean;
}

type CompressDocsMode = "check" | "write";
type DocumentAction = "checked" | "written" | "unchanged";

const TEAM_GUIDE_MAX_RECOMMENDED_BYTES = 12 * 1024;

interface ArtifactSnapshot {
  commands: string[];
  paths: string[];
  urls: string[];
  codeFenceMarkers: number;
}

interface DocumentCompressionSummary {
  path: string;
  relative_path: string;
  action: DocumentAction;
  original_bytes: number;
  compressed_bytes: number;
  bytes_saved: number;
  original_lines: number;
  compressed_lines: number;
  lines_saved: number;
  commands_preserved: number;
  paths_preserved: number;
  urls_preserved: number;
  code_fences_preserved: boolean;
  risk_section_present: boolean;
  manual_review_recommended: boolean;
  warnings: CommandWarning[];
}

export interface CompressDocsResult extends CommandResult {
  summary: {
    target_path: string;
    mode: CompressDocsMode;
    documents: DocumentCompressionSummary[];
    totals: {
      original_bytes: number;
      compressed_bytes: number;
      bytes_saved: number;
      original_lines: number;
      compressed_lines: number;
      lines_saved: number;
      documents_changed: number;
    };
    next_steps: string[];
  };
}

export async function runCompressDocsCommand(options: CompressDocsOptions = {}): Promise<CompressDocsResult> {
  const mode = normalizeMode(options);
  const targetPath = resolveRepoRoot(options.target?.trim() || process.cwd());

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`compress-docs target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const candidateFiles = await collectCandidateFiles(targetPath);
  const documentSummaries: DocumentCompressionSummary[] = [];

  for (const filePath of candidateFiles) {
    const original = await readTextFile(filePath);
    const compressionCandidate = compressMarkdownText(original);
    const compressed = byteLength(compressionCandidate) < byteLength(original) ? compressionCandidate : original;
    const summary = buildDocumentSummary({
      targetPath,
      filePath,
      original,
      compressed,
      action: compressed !== original ? (mode === "write" ? "written" : "checked") : "unchanged",
    });

    if (mode === "write" && compressed !== original) {
      await writeTextFileAtomic(filePath, compressed);
    }

    documentSummaries.push(summary);
  }

  const warnings: CommandWarning[] = [];
  if (candidateFiles.length === 0) {
    warnings.push({
      code: "compress_docs_no_candidates",
      message: "No TEAM_GUIDE.md, AGENTS.override.md, or autonomy/context/*.md documents were found.",
    });
  }

  for (const summary of documentSummaries) {
    warnings.push(...summary.warnings);
  }

  return {
    ok: true,
    message: buildResultMessage(mode, documentSummaries),
    summary: {
      target_path: targetPath,
      mode,
      documents: documentSummaries,
      totals: buildTotals(documentSummaries),
      next_steps: buildNextSteps(mode, documentSummaries),
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function registerCompressDocsCommand(program: Command): void {
  program
    .command("compress-docs")
    .option("--target <path>", "Target repository root")
    .option("--check", "Preview compression without writing files")
    .option("--write", "Write compressed project context documents")
    .description("Compress repo context docs while preserving commands, paths, URLs, fences, and risk sections")
    .action(async (options: CompressDocsOptions) => {
      const result = await runCompressDocsCommand(options);
      console.log(JSON.stringify(result, null, 2));
    });
}

function normalizeMode(options: CompressDocsOptions): CompressDocsMode {
  if (options.check === true && options.write === true) {
    throw new CliError("compress-docs accepts either --check or --write, not both.", CLI_EXIT_CODES.usage);
  }

  return options.write === true ? "write" : "check";
}

async function collectCandidateFiles(targetPath: string): Promise<string[]> {
  const candidates = [
    path.join(targetPath, "TEAM_GUIDE.md"),
    path.join(targetPath, "AGENTS.override.md"),
    ...(await collectContextMarkdownFiles(targetPath)),
  ];

  const existing: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (await isFile(normalized)) {
      existing.push(normalized);
    }
  }

  return existing.sort((left, right) => left.localeCompare(right));
}

async function collectContextMarkdownFiles(targetPath: string): Promise<string[]> {
  const contextDir = path.join(targetPath, "autonomy", "context");
  if (!(await isDirectory(contextDir))) {
    return [];
  }

  const entries = await fs.readdir(contextDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(contextDir, entry.name));
}

export function compressMarkdownText(source: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  let inFence = false;
  let previousOutsideLine: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/g, "");

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      output.push(line);
      previousOutsideLine = null;
      continue;
    }

    if (inFence) {
      output.push(rawLine);
      continue;
    }

    if (line.trim() === "") {
      if (output.length === 0 || output[output.length - 1]?.trim() === "") {
        continue;
      }
      output.push("");
      previousOutsideLine = null;
      continue;
    }

    const compactLine = line;
    if (previousOutsideLine === compactLine && isSafeDuplicateLine(compactLine)) {
      continue;
    }

    output.push(compactLine);
    previousOutsideLine = compactLine;
  }

  while (output.length > 0 && output[output.length - 1]?.trim() === "") {
    output.pop();
  }

  return `${output.join(newline)}${newline}`;
}

function isSafeDuplicateLine(line: string): boolean {
  if (line.startsWith("#")) {
    return false;
  }
  if (/^\|.*\|$/.test(line)) {
    return false;
  }

  return true;
}

function buildDocumentSummary(options: {
  targetPath: string;
  filePath: string;
  original: string;
  compressed: string;
  action: DocumentAction;
}): DocumentCompressionSummary {
  const before = extractArtifacts(options.original);
  const after = extractArtifacts(options.compressed);
  const warnings = buildWarnings({
    relativePath: path.relative(options.targetPath, options.filePath).replace(/\\/g, "/"),
    original: options.original,
    compressed: options.compressed,
    before,
    after,
  });

  return {
    path: options.filePath,
    relative_path: path.relative(options.targetPath, options.filePath).replace(/\\/g, "/"),
    action: options.action,
    original_bytes: byteLength(options.original),
    compressed_bytes: byteLength(options.compressed),
    bytes_saved: Math.max(0, byteLength(options.original) - byteLength(options.compressed)),
    original_lines: lineCount(options.original),
    compressed_lines: lineCount(options.compressed),
    lines_saved: Math.max(0, lineCount(options.original) - lineCount(options.compressed)),
    commands_preserved: countPreserved(before.commands, options.compressed),
    paths_preserved: countPreserved(before.paths, options.compressed),
    urls_preserved: countPreserved(before.urls, options.compressed),
    code_fences_preserved: before.codeFenceMarkers === after.codeFenceMarkers,
    risk_section_present: hasRiskSection(options.compressed),
    manual_review_recommended: warnings.length > 0,
    warnings,
  };
}

function extractArtifacts(text: string): ArtifactSnapshot {
  return {
    commands: uniqueMatches(text, [
      /`((?:codex-autonomy|npm|pnpm|yarn|node|npx|python|py|pwsh|powershell|git|gh)\b[^`]*)`/gi,
      /(?:^|\s)((?:codex-autonomy|npm|pnpm|yarn|node|npx|python|py|pwsh|powershell|git|gh)\b[^\n]*)/gim,
    ]),
    paths: uniqueMatches(text, [
      /([A-Za-z]:[\\/][^\s)`]+(?:[\\/][^\s)`]+)*)/g,
      /((?:\.{1,2}[\\/])?(?:[\w$.-]+[\\/])+[\w$.-]+(?:\.[A-Za-z0-9]+)?)/g,
    ]),
    urls: uniqueMatches(text, [/(https?:\/\/[^\s)>\]]+)/g]),
    codeFenceMarkers: [...text.matchAll(/^\s*```/gm)].length,
  };
}

function uniqueMatches(text: string, patterns: RegExp[]): string[] {
  const values = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? match[0] ?? "").trim();
      if (value) {
        values.add(value);
      }
    }
  }

  return [...values].sort((left, right) => left.localeCompare(right));
}

function countPreserved(artifacts: string[], text: string): number {
  return artifacts.filter((artifact) => text.includes(artifact)).length;
}

function buildWarnings(options: {
  relativePath: string;
  original: string;
  compressed: string;
  before: ArtifactSnapshot;
  after: ArtifactSnapshot;
}): CommandWarning[] {
  const warnings: CommandWarning[] = [];

  if (options.before.codeFenceMarkers !== options.after.codeFenceMarkers) {
    warnings.push({
      code: "compress_docs_code_fence_mismatch",
      message: `${options.relativePath} changed the number of markdown code fence markers.`,
    });
  }
  if (!allPreserved(options.before.commands, options.compressed)) {
    warnings.push({
      code: "compress_docs_command_loss",
      message: `${options.relativePath} lost at least one command-like artifact.`,
    });
  }
  if (!allPreserved(options.before.paths, options.compressed)) {
    warnings.push({
      code: "compress_docs_path_loss",
      message: `${options.relativePath} lost at least one path-like artifact.`,
    });
  }
  if (!allPreserved(options.before.urls, options.compressed)) {
    warnings.push({
      code: "compress_docs_url_loss",
      message: `${options.relativePath} lost at least one URL artifact.`,
    });
  }
  if (path.basename(options.relativePath).toLowerCase() === "team_guide.md" && !hasRiskSection(options.compressed)) {
    warnings.push({
      code: "compress_docs_team_guide_no_risk_section",
      message: `${options.relativePath} does not contain an obvious risk section after compression.`,
    });
  }
  if (
    path.basename(options.relativePath).toLowerCase() === "team_guide.md"
    && byteLength(options.compressed) > TEAM_GUIDE_MAX_RECOMMENDED_BYTES
  ) {
    warnings.push({
      code: "compress_docs_team_guide_over_budget",
      message: `${options.relativePath} is still over the recommended 12 KiB project-context budget after safe compression.`,
    });
  }

  return warnings;
}

function allPreserved(artifacts: string[], text: string): boolean {
  return artifacts.every((artifact) => text.includes(artifact));
}

function hasRiskSection(text: string): boolean {
  return /^#{1,6}\s+.*(?:risk|risks|known unknown|风险|高风险|已知限制)/gim.test(text);
}

function buildTotals(documents: DocumentCompressionSummary[]): CompressDocsResult["summary"]["totals"] {
  return documents.reduce(
    (totals, document) => ({
      original_bytes: totals.original_bytes + document.original_bytes,
      compressed_bytes: totals.compressed_bytes + document.compressed_bytes,
      bytes_saved: totals.bytes_saved + document.bytes_saved,
      original_lines: totals.original_lines + document.original_lines,
      compressed_lines: totals.compressed_lines + document.compressed_lines,
      lines_saved: totals.lines_saved + document.lines_saved,
      documents_changed: totals.documents_changed + (document.action === "checked" || document.action === "written" ? 1 : 0),
    }),
    {
      original_bytes: 0,
      compressed_bytes: 0,
      bytes_saved: 0,
      original_lines: 0,
      compressed_lines: 0,
      lines_saved: 0,
      documents_changed: 0,
    },
  );
}

function buildResultMessage(mode: CompressDocsMode, documents: DocumentCompressionSummary[]): string {
  const totals = buildTotals(documents);
  const verb = mode === "write" ? "wrote" : "checked";
  return `compress-docs ${verb} ${documents.length} document(s); ${totals.bytes_saved} bytes and ${totals.lines_saved} lines can be saved.`;
}

function buildNextSteps(mode: CompressDocsMode, documents: DocumentCompressionSummary[]): string[] {
  if (documents.length === 0) {
    return ["Create or refresh TEAM_GUIDE.md before expecting project context compression to help."];
  }

  if (documents.some((document) => document.manual_review_recommended)) {
    return ["Review warning-bearing documents before treating the compressed project context as the new baseline."];
  }

  if (mode === "check" && documents.some((document) => document.action === "checked")) {
    return ["Run codex-autonomy compress-docs --target <repo> --write to apply the safe compression preview."];
  }

  return ["Keep TEAM_GUIDE.md as a current-state snapshot and rerun project-sync after durable project changes."];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function lineCount(value: string): number {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0) {
    return 0;
  }

  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n").length : normalized.split("\n").length;
}
