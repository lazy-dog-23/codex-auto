import { readFile } from "node:fs/promises";
import { parse, type TomlTable as SmolTomlTable, type TomlValue as SmolTomlValue } from "smol-toml";

export type TomlValue = SmolTomlValue;
export type TomlDocument = SmolTomlTable;
export type TomlTable = TomlDocument;
export type TomlArray = Extract<TomlValue, readonly unknown[]>;
export type TomlPrimitive = Exclude<TomlValue, TomlArray | TomlTable>;

export type SimpleTomlValue = TomlValue;
export type SimpleTomlDocument = TomlDocument;

export function parseToml(text: string): TomlDocument {
  const normalized = text.startsWith("\ufeff") ? text.slice(1) : text;
  return parse(normalized) as TomlDocument;
}

export async function readTomlFile(filePath: string): Promise<TomlDocument> {
  const text = await readFile(filePath, "utf8");
  return parseToml(text);
}

export const parseSimpleToml = parseToml;
export const readSimpleTomlFile = readTomlFile;

export function lookupTomlValue(document: TomlDocument, path: readonly string[]): unknown {
  let current: unknown = document;

  for (const segment of path) {
    if (!isTomlTable(current)) {
      return undefined;
    }

    current = current[segment];
    if (current === undefined) {
      return undefined;
    }
  }

  return current;
}

function isTomlTable(value: unknown): value is TomlTable {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
