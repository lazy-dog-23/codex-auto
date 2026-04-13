import { access } from "node:fs/promises";
import path from "node:path";

import { commandSucceeded, runProcess } from "./process.js";

export type CliInstallState = "global_available" | "global_missing";

export async function detectGlobalCliInstall(commandName = "codex-autonomy"): Promise<CliInstallState> {
  const directProbe = runProcess(commandName, ["--help"]);
  if (commandSucceeded(directProbe)) {
    return "global_available";
  }

  for (const prefix of buildCandidatePrefixes()) {
    for (const candidate of buildCliCandidates(prefix, commandName)) {
      try {
        await access(candidate);
        return "global_available";
      } catch {
        continue;
      }
    }
  }

  return "global_missing";
}

function buildCandidatePrefixes(): string[] {
  const prefixes = new Set<string>();
  const envPrefix = process.env.npm_config_prefix?.trim();
  if (envPrefix) {
    prefixes.add(envPrefix);
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      prefixes.add(path.join(appData, "npm"));
    }
  } else {
    const home = process.env.HOME?.trim();
    if (home) {
      prefixes.add(path.join(home, ".npm-global", "bin"));
      prefixes.add(path.join(home, ".local", "bin"));
    }

    prefixes.add("/usr/local/bin");
    prefixes.add("/usr/bin");
  }

  return [...prefixes];
}

function buildCliCandidates(prefix: string, commandName: string): string[] {
  if (process.platform === "win32") {
    return [
      path.join(prefix, `${commandName}.cmd`),
      path.join(prefix, `${commandName}.ps1`),
      path.join(prefix, `${commandName}.exe`),
      path.join(prefix, commandName),
    ];
  }

  return [
    path.join(prefix, "bin", commandName),
    path.join(prefix, commandName),
  ];
}
