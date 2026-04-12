import { pathExists, readTextFile, writeTextFileAtomic } from "./json.js";

export interface JournalEntryInput {
  timestamp: string;
  actor: string;
  taskId: string;
  result: string;
  summary: string;
  verify: string;
  blocker: string;
}

export function formatJournalEntry(entry: JournalEntryInput): string {
  return [
    `## ${entry.timestamp} | ${entry.actor} | task: ${entry.taskId}`,
    `- result: ${entry.result}`,
    `- summary: ${entry.summary}`,
    `- verify: ${entry.verify}`,
    `- blocker: ${entry.blocker}`,
    "",
  ].join("\n");
}

export async function appendJournalEntry(journalPath: string, entry: JournalEntryInput): Promise<void> {
  const entryBlock = formatJournalEntry(entry);
  const existing = (await pathExists(journalPath)) ? await readTextFile(journalPath) : "";
  const normalized = existing.length === 0
    ? ""
    : (existing.endsWith("\n") ? existing : `${existing}\n`);
  const needsBlankLine = normalized.length > 0 && !normalized.endsWith("\n\n");
  const nextContent = `${normalized}${needsBlankLine ? "\n" : ""}${entryBlock}`;
  await writeTextFileAtomic(journalPath, nextContent);
}
