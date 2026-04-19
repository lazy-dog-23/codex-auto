import { describe, expect, it } from "vitest";

import { isAllowlistedAutonomyCommitPath, isAmbientAutonomyCommitPath } from "../src/infra/git.js";
import { isAutonomyRuntimeAllowlistedPath } from "../src/shared/paths.js";

describe("autonomy commit allowlist", () => {
  it("matches allowlisted paths case-insensitively for Windows-native worktrees", () => {
    expect(isAllowlistedAutonomyCommitPath("Autonomy/journal.md")).toBe(true);
    expect(isAllowlistedAutonomyCommitPath("Scripts/review.ps1")).toBe(true);
    expect(isAllowlistedAutonomyCommitPath(".Agents/skills/$autonomy-plan/SKILL.md")).toBe(true);
    expect(isAllowlistedAutonomyCommitPath("AGENTS.override.md")).toBe(false);
    expect(isAmbientAutonomyCommitPath("AGENTS.override.md")).toBe(true);
    expect(isAmbientAutonomyCommitPath("TEAM_GUIDE.md")).toBe(true);
    expect(isAllowlistedAutonomyCommitPath("autonomy/context/repo-map.json")).toBe(true);
    expect(isAmbientAutonomyCommitPath("autonomy/context/repo-map.json")).toBe(false);
    expect(isAllowlistedAutonomyCommitPath("graphify-out/graph.json")).toBe(false);
    expect(isAmbientAutonomyCommitPath("graphify-out/graph.json")).toBe(false);
    expect(isAutonomyRuntimeAllowlistedPath("graphify-out/graph.json")).toBe(true);
    expect(isAllowlistedAutonomyCommitPath("README.md")).toBe(false);
  });
});
