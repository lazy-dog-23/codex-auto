export const MANAGED_README_SECTION_START = "<!-- codex-autonomy:managed:start -->";
export const MANAGED_README_SECTION_END = "<!-- codex-autonomy:managed:end -->";
export const MANAGED_README_MAX_FILE_BYTES = 24 * 1024;
export const MANAGED_README_MAX_SECTION_BYTES = 8 * 1024;

export interface ManagedReadmeSectionResult {
  ok: boolean;
  mode: "create_file" | "insert_section" | "update_section" | "no_change" | "unsupported";
  content?: string;
  sectionContent?: string;
  reasonCode?: "readme_too_large" | "readme_has_nul" | "readme_markers_invalid";
  reasonMessage?: string;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeSectionBody(value: string): string {
  return normalizeNewlines(value).trimEnd();
}

function wrapManagedSection(sectionContent: string): string {
  const normalizedSection = normalizeSectionBody(sectionContent);
  return [
    MANAGED_README_SECTION_START,
    normalizedSection,
    MANAGED_README_SECTION_END,
  ].join("\n");
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasNulCharacter(value: string): boolean {
  return value.includes("\u0000");
}

function findMarkerIndexes(content: string) {
  const start = content.indexOf(MANAGED_README_SECTION_START);
  const end = content.indexOf(MANAGED_README_SECTION_END);
  const secondStart = start >= 0 ? content.indexOf(MANAGED_README_SECTION_START, start + MANAGED_README_SECTION_START.length) : -1;
  const secondEnd = end >= 0 ? content.indexOf(MANAGED_README_SECTION_END, end + MANAGED_README_SECTION_END.length) : -1;
  return { start, end, secondStart, secondEnd };
}

export function createMinimalManagedReadme(sectionContent: string): string {
  return [
    "# codex-autonomy",
    "",
    wrapManagedSection(sectionContent),
    "",
  ].join("\n");
}

export function extractManagedReadmeSection(content: string): string | null {
  const normalized = normalizeNewlines(content);
  const { start, end, secondStart, secondEnd } = findMarkerIndexes(normalized);
  if (start < 0 || end < 0 || secondStart >= 0 || secondEnd >= 0 || end < start) {
    return null;
  }

  const innerStart = start + MANAGED_README_SECTION_START.length;
  const inner = normalized.slice(innerStart, end);
  return normalizeSectionBody(inner.replace(/^\n/, ""));
}

export function classifyManagedReadme(content: string): ManagedReadmeSectionResult {
  const normalized = normalizeNewlines(content);
  if (hasNulCharacter(normalized)) {
    return {
      ok: false,
      mode: "unsupported",
      reasonCode: "readme_has_nul",
      reasonMessage: "README.md contains NUL bytes and cannot be managed as a Markdown section.",
    };
  }

  if (utf8ByteLength(normalized) > MANAGED_README_MAX_FILE_BYTES) {
    return {
      ok: false,
      mode: "unsupported",
      reasonCode: "readme_too_large",
      reasonMessage: `README.md exceeds the ${MANAGED_README_MAX_FILE_BYTES} byte managed baseline limit.`,
    };
  }

  const { start, end, secondStart, secondEnd } = findMarkerIndexes(normalized);
  if (start < 0 && end < 0) {
    return {
      ok: true,
      mode: "insert_section",
      content: normalized,
    };
  }

  if (start < 0 || end < 0 || secondStart >= 0 || secondEnd >= 0 || end < start) {
    return {
      ok: false,
      mode: "unsupported",
      reasonCode: "readme_markers_invalid",
      reasonMessage: "README.md contains invalid codex-autonomy managed section markers.",
    };
  }

  return {
    ok: true,
    mode: "update_section",
    content: normalized,
    sectionContent: extractManagedReadmeSection(normalized) ?? "",
  };
}

export function upsertManagedReadmeSection(existingContent: string | null, sectionContent: string): ManagedReadmeSectionResult {
  const normalizedSection = normalizeSectionBody(sectionContent);
  if (utf8ByteLength(normalizedSection) > MANAGED_README_MAX_SECTION_BYTES) {
    return {
      ok: false,
      mode: "unsupported",
      reasonCode: "readme_too_large",
      reasonMessage: `Managed README section exceeds the ${MANAGED_README_MAX_SECTION_BYTES} byte limit.`,
    };
  }

  if (existingContent == null) {
    return {
      ok: true,
      mode: "create_file",
      content: createMinimalManagedReadme(normalizedSection),
      sectionContent: normalizedSection,
    };
  }

  const classified = classifyManagedReadme(existingContent);
  if (!classified.ok || typeof classified.content !== "string") {
    return classified;
  }

  if (classified.mode === "insert_section") {
    const base = classified.content.trimEnd();
    const content = [
      base,
      base.length > 0 ? "" : null,
      wrapManagedSection(normalizedSection),
      "",
    ]
      .filter((part): part is string => part !== null)
      .join("\n");

    return {
      ok: true,
      mode: "insert_section",
      content,
      sectionContent: normalizedSection,
    };
  }

  const normalizedExistingSection = normalizeSectionBody(classified.sectionContent ?? "");
  if (normalizedExistingSection === normalizedSection) {
    return {
      ok: true,
      mode: "no_change",
      content: classified.content,
      sectionContent: normalizedSection,
    };
  }

  const start = classified.content.indexOf(MANAGED_README_SECTION_START);
  const end = classified.content.indexOf(MANAGED_README_SECTION_END);
  const replaced = [
    classified.content.slice(0, start),
    wrapManagedSection(normalizedSection),
    classified.content.slice(end + MANAGED_README_SECTION_END.length),
  ].join("");

  return {
    ok: true,
    mode: "update_section",
    content: replaced.endsWith("\n") ? replaced : `${replaced}\n`,
    sectionContent: normalizedSection,
  };
}
