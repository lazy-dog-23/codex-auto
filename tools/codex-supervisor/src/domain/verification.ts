import { basename, join } from "node:path";

import type { GoalRecord, VerificationAxis, VerificationDocument } from "../contracts/autonomy.js";
import { loadJsonFile, pathExists, readTextFile } from "../infra/fs.js";

const STRONG_TEMPLATE_KEYWORDS = [
  "audit",
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
  "onboarding",
  "extensibility",
  "extend",
  "safety",
  "risk",
  "review",
  "verify",
  "diagnose",
  "inspect",
  "system",
  "体检",
  "安全",
  "健壮",
  "稳健",
  "可用性",
  "上手难度",
  "扩展性",
  "审查",
  "评估",
  "加固",
];

const PACKAGE_MANIFEST_CANDIDATES = [
  "package.json",
  "frontend/package.json",
  "client/package.json",
  "web/package.json",
  "app/package.json",
  "tools/codex-supervisor/package.json",
];

const PLAYWRIGHT_CONFIG_CANDIDATES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
  "frontend/playwright.config.ts",
  "frontend/playwright.config.js",
  "frontend/playwright.config.mjs",
  "frontend/playwright.config.cjs",
  "tests/playwright.config.ts",
  "tests/playwright.config.js",
];

const PYTHON_SIGNAL_CANDIDATES = [
  "pyproject.toml",
  "pytest.ini",
  "requirements.txt",
  "requirements-dev.txt",
  "backend/pyproject.toml",
  "backend/pytest.ini",
];

const CAPACITOR_SIGNAL_CANDIDATES = [
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.json",
  "android",
  "ios",
];

interface VerificationRepoSignals {
  packageScripts: string[];
  hasPythonSignals: boolean;
  hasBuildSignals: boolean;
  hasSmokeSignals: boolean;
  hasPlaywrightSignals: boolean;
  hasCrossBrowserSignals: boolean;
  hasMobileSignals: boolean;
  hasSecurityDocs: boolean;
}

export interface VerificationSummary {
  required: number;
  passed: number;
  pending: number;
}

export function createEmptyVerificationDocument(): VerificationDocument {
  return {
    version: 1,
    goal_id: null,
    policy: "strong_template",
    axes: [],
  };
}

export function goalUsesStrongVerification(goal: GoalRecord | null): boolean {
  if (!goal) {
    return false;
  }

  const text = [
    goal.title,
    goal.objective,
    ...goal.success_criteria,
    ...goal.constraints,
    ...goal.out_of_scope,
  ].join(" ").toLowerCase();

  return STRONG_TEMPLATE_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

export async function ensureGoalVerificationDocument(
  goal: GoalRecord | null,
  repoRoot: string,
  existingDocument?: VerificationDocument | null,
): Promise<VerificationDocument> {
  if (!goal) {
    return createEmptyVerificationDocument();
  }

  if (!goalUsesStrongVerification(goal)) {
    return {
      version: 1,
      goal_id: goal.id,
      policy: "strong_template",
      axes: [],
    };
  }

  const signals = await collectVerificationSignals(repoRoot);
  const expectedAxes = buildStrongTemplateAxes(signals);
  const previousAxes = new Map(
    existingDocument?.goal_id === goal.id
      ? existingDocument.axes.map((axis) => [axis.id, axis])
      : [],
  );

  const axes = expectedAxes.map((axis) => mergeVerificationAxis(axis, previousAxes.get(axis.id)));

  return {
    version: 1,
    goal_id: goal.id,
    policy: "strong_template",
    axes,
  };
}

export function summarizeVerification(document: VerificationDocument | null, goalId: string | null): VerificationSummary {
  const relevantAxes = getRelevantAxes(document, goalId).filter((axis) => axis.required);
  const passed = relevantAxes.filter((axis) => axis.status === "passed" || axis.status === "not_applicable").length;
  const pending = relevantAxes.filter((axis) => axis.status !== "passed" && axis.status !== "not_applicable").length;

  return {
    required: relevantAxes.length,
    passed,
    pending,
  };
}

export function listPendingRequiredVerificationAxes(document: VerificationDocument | null, goalId: string | null): VerificationAxis[] {
  return getRelevantAxes(document, goalId).filter((axis) =>
    axis.required && axis.status !== "passed" && axis.status !== "not_applicable"
  );
}

export function isGoalCompletionBlockedByVerification(document: VerificationDocument | null, goalId: string | null): boolean {
  return listPendingRequiredVerificationAxes(document, goalId).length > 0;
}

export function buildVerificationPendingAxisLabels(document: VerificationDocument | null, goalId: string | null): string[] | null {
  const axes = listPendingRequiredVerificationAxes(document, goalId).map((axis) => axis.id);
  return axes.length > 0 ? axes : null;
}

function getRelevantAxes(document: VerificationDocument | null, goalId: string | null): VerificationAxis[] {
  if (!document || !goalId || document.goal_id !== goalId) {
    return [];
  }

  return document.axes;
}

function mergeVerificationAxis(nextAxis: VerificationAxis, previousAxis?: VerificationAxis): VerificationAxis {
  if (!previousAxis) {
    return nextAxis;
  }

  return {
    ...nextAxis,
    status: previousAxis.status,
    evidence: dedupeStrings([...previousAxis.evidence]),
    source_task_id: previousAxis.source_task_id ?? nextAxis.source_task_id,
    last_checked_at: previousAxis.last_checked_at ?? nextAxis.last_checked_at,
    reason: previousAxis.reason ?? nextAxis.reason,
  };
}

function buildStrongTemplateAxes(signals: VerificationRepoSignals): VerificationAxis[] {
  const axes: VerificationAxis[] = [
    createAxis("git_state", "Validate autonomy branch and worktree state", true, [
      "Confirm the repo and background worktree are aligned before closing the goal.",
    ]),
    createAxis("security_review", "Capture a security and risk closeout summary", true, [
      "Summarize remaining risks, blockers, and sensitive side effects before completion.",
    ]),
  ];

  if (signals.hasPythonSignals) {
    axes.push(createAxis("python_tests", "Run the Python test suite or targeted Python regression checks", true));
  }

  if (signals.packageScripts.some((script) => script === "frontend:test" || script === "test" || script.includes("test"))) {
    axes.push(createAxis("frontend_tests", "Run frontend/unit test coverage for the affected surface", true));
  }

  if (signals.hasBuildSignals) {
    axes.push(createAxis("build", "Run the build or compile gate for the affected workspace", true));
  }

  if (signals.hasSmokeSignals) {
    axes.push(createAxis("smoke", "Run the smoke gate and capture the result", true));
  }

  if (signals.hasPlaywrightSignals) {
    axes.push(createAxis("full_e2e", "Run the full e2e or Playwright regression path before closing the goal", true));
  }

  if (signals.hasCrossBrowserSignals) {
    axes.push(createAxis("cross_browser_matrix", "Cover the configured multi-browser Playwright matrix", true));
  }

  if (signals.hasMobileSignals) {
    axes.push(createAxis("mobile_native_validation", "Validate the mobile/native shell path for the affected goal", true));
  }

  return axes;
}

function createAxis(id: string, title: string, required: boolean, evidence: string[] = []): VerificationAxis {
  return {
    id,
    title,
    required,
    status: "pending",
    evidence: dedupeStrings(evidence),
    source_task_id: null,
    last_checked_at: null,
    reason: null,
  };
}

async function collectVerificationSignals(repoRoot: string): Promise<VerificationRepoSignals> {
  const packageScripts = await collectPackageScripts(repoRoot);
  const hasPythonSignals = await hasAnyCandidate(repoRoot, PYTHON_SIGNAL_CANDIDATES);
  const hasPlaywrightSignals = await hasPlaywrightCapability(repoRoot, packageScripts);
  const hasCrossBrowserSignals = await hasMultiBrowserPlaywright(repoRoot);
  const hasMobileSignals = await hasAnyCandidate(repoRoot, CAPACITOR_SIGNAL_CANDIDATES);
  const hasSecurityDocs = await hasAnyReadableFile(repoRoot, [
    "README.md",
    "docs/security-review.md",
    "docs/security.md",
    "docs/risk.md",
  ], /security|risk|安全|风控|审查/i);

  return {
    packageScripts,
    hasPythonSignals,
    hasBuildSignals: packageScripts.some((script) => script.includes("build")) || await pathExists(join(repoRoot, "tsconfig.json")),
    hasSmokeSignals: packageScripts.some((script) => script.includes("smoke")) || await pathExists(join(repoRoot, "scripts", "smoke.ps1")),
    hasPlaywrightSignals,
    hasCrossBrowserSignals,
    hasMobileSignals,
    hasSecurityDocs,
  };
}

async function collectPackageScripts(repoRoot: string): Promise<string[]> {
  const scripts = new Set<string>();

  for (const candidate of PACKAGE_MANIFEST_CANDIDATES) {
    const manifestPath = join(repoRoot, candidate);
    if (!(await pathExists(manifestPath))) {
      continue;
    }

    try {
      const manifest = await loadJsonFile<Record<string, unknown>>(manifestPath);
      const scriptValue = manifest.scripts;
      if (!scriptValue || typeof scriptValue !== "object" || Array.isArray(scriptValue)) {
        continue;
      }

      for (const [name, value] of Object.entries(scriptValue)) {
        if (typeof value === "string" && value.trim().length > 0) {
          scripts.add(name);
          if (/playwright|vitest|jest|pytest|e2e/i.test(value)) {
            scripts.add(`${name}:script-signal`);
          }
        }
      }
    } catch {
      continue;
    }
  }

  return [...scripts].sort((left, right) => left.localeCompare(right));
}

async function hasPlaywrightCapability(repoRoot: string, packageScripts: string[]): Promise<boolean> {
  if (packageScripts.some((script) => /playwright|e2e/i.test(script))) {
    return true;
  }

  for (const candidate of PLAYWRIGHT_CONFIG_CANDIDATES) {
    if (await pathExists(join(repoRoot, candidate))) {
      return true;
    }
  }

  return false;
}

async function hasMultiBrowserPlaywright(repoRoot: string): Promise<boolean> {
  for (const candidate of PLAYWRIGHT_CONFIG_CANDIDATES) {
    const configPath = join(repoRoot, candidate);
    if (!(await pathExists(configPath))) {
      continue;
    }

    try {
      const content = await readTextFile(configPath);
      if (/projects\s*:\s*\[.*chromium.*firefox|webkit/is.test(content)) {
        return true;
      }
      if (/chromium/i.test(content) && /firefox|webkit/i.test(content)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function hasAnyCandidate(repoRoot: string, candidates: readonly string[]): Promise<boolean> {
  for (const candidate of candidates) {
    if (await pathExists(join(repoRoot, candidate))) {
      return true;
    }
  }

  return false;
}

async function hasAnyReadableFile(repoRoot: string, candidates: readonly string[], pattern: RegExp): Promise<boolean> {
  for (const candidate of candidates) {
    const filePath = join(repoRoot, candidate);
    if (!(await pathExists(filePath))) {
      continue;
    }

    try {
      const content = await readTextFile(filePath);
      if (pattern.test(content) || pattern.test(basename(filePath))) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}
