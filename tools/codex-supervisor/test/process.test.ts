import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

describe("process helpers", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("builds a Codex detection script with an exact process allowlist", async () => {
    const { buildCodexProcessDetectionScript } = await import("../src/infra/process.js");

    const script = buildCodexProcessDetectionScript();

    expect(script).toContain("Get-Process");
    expect(script).toContain("ToLowerInvariant");
    expect(script).toContain("$allowed");
    expect(script).not.toContain(".Path");
    expect(script).not.toContain('ProcessName | Where-Object { $_ -match "Codex|OpenAI" }');
    expect(script).toContain("; ");
  });

  it("deduplicates detected Codex process names", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "Codex\r\nCodex\r\ncodex\r\n",
      stderr: "",
      error: undefined,
    });

    const { detectCodexProcess } = await import("../src/infra/process.js");
    const result = detectCodexProcess("pwsh");

    expect(result.probeOk).toBe(true);
    expect(result.running).toBe(true);
    expect(result.matches).toEqual(["Codex", "codex"]);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it("reports probe failures separately from a clean not-running result", async () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "Access is denied.",
      error: new Error("spawnSync pwsh EPERM"),
    });

    const { detectCodexProcess } = await import("../src/infra/process.js");
    const result = detectCodexProcess("pwsh");

    expect(result.probeOk).toBe(false);
    expect(result.running).toBe(false);
    expect(result.error).toContain("EPERM");
  });
});
