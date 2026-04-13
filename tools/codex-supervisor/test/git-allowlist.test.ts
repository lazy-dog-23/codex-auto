import { describe, expect, it } from "vitest";

import { isAllowlistedAutonomyCommitPath } from "../src/infra/git.js";

describe("autonomy commit allowlist", () => {
  it("matches allowlisted paths case-insensitively for Windows-native worktrees", () => {
    expect(isAllowlistedAutonomyCommitPath("Autonomy/journal.md")).toBe(true);
    expect(isAllowlistedAutonomyCommitPath("Scripts/review.ps1")).toBe(true);
    expect(isAllowlistedAutonomyCommitPath(".Agents/skills/$autonomy-plan/SKILL.md")).toBe(true);
    expect(isAllowlistedAutonomyCommitPath("README.md")).toBe(false);
  });
});
