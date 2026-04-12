import { readFile } from "node:fs/promises";

export type SimpleTomlValue = string | boolean | number;
export type SimpleTomlDocument = Record<string, Record<string, SimpleTomlValue>>;

export function parseSimpleToml(text: string): SimpleTomlDocument {
  const document: SimpleTomlDocument = { "": {} };
  let currentSection = "";

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    const sectionMatch = line.match(/^\[(?<name>[^\[\]]+)\]$/);
    if (sectionMatch?.groups?.name) {
      currentSection = sectionMatch.groups.name.trim();
      document[currentSection] ??= {};
      continue;
    }

    if (line.startsWith("[[")) {
      throw new Error(`Unsupported TOML array-of-tables at line ${index + 1}.`);
    }

    const keyValueMatch = line.match(/^(?<key>[A-Za-z0-9_.:-]+)\s*=\s*(?<value>.+)$/);
    if (!keyValueMatch?.groups?.key || keyValueMatch.groups.value === undefined) {
      throw new Error(`Unsupported TOML syntax at line ${index + 1}.`);
    }

    const key = keyValueMatch.groups.key.trim();
    const rawValue = keyValueMatch.groups.value.trim();
    const section = document[currentSection] ?? (document[currentSection] = {});
    section[key] = parseSimpleTomlValue(rawValue, index + 1);
  }

  return document;
}

export async function readSimpleTomlFile(filePath: string): Promise<SimpleTomlDocument> {
  const text = await readFile(filePath, "utf8");
  return parseSimpleToml(text);
}

function parseSimpleTomlValue(rawValue: string, lineNumber: number): SimpleTomlValue {
  if (/^".*"$/.test(rawValue)) {
    return rawValue.slice(1, -1);
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  if (/^-?\d+$/.test(rawValue)) {
    return Number(rawValue);
  }

  throw new Error(`Unsupported TOML value at line ${lineNumber}.`);
}
