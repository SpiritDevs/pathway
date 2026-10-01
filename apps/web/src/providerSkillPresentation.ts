import type { ServerProviderSkill } from "@spiritdevs/contracts";

// Words that read wrong when only their first letter is capitalised.
const SKILL_NAME_WORDS: Record<string, string> = {
  ai: "AI",
  api: "API",
  ci: "CI",
  cli: "CLI",
  css: "CSS",
  gh: "GitHub",
  github: "GitHub",
  html: "HTML",
  ios: "iOS",
  ipados: "iPadOS",
  json: "JSON",
  llm: "LLM",
  macos: "macOS",
  mcp: "MCP",
  pr: "PR",
  sdk: "SDK",
  seo: "SEO",
  sql: "SQL",
  tvos: "tvOS",
  ui: "UI",
  url: "URL",
  ux: "UX",
  visionos: "visionOS",
  watchos: "watchOS",
};

const MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    const lower = segment.toLowerCase();
    words.push(
      SKILL_NAME_WORDS[lower] ??
        (words.length > 0 && MINOR_WORDS.has(lower)
          ? lower
          : segment.charAt(0).toUpperCase() + segment.slice(1)),
    );
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  // Plugin skills are namespaced as `plugin:skill`; the skill part names it.
  return titleCaseWords(skill.name.slice(skill.name.lastIndexOf(":") + 1));
}

export function formatProviderSkillInstallSource(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): string | null {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "App";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  if (normalizedScope === "system") {
    return "System";
  }
  if (
    normalizedScope === "project" ||
    normalizedScope === "workspace" ||
    normalizedScope === "local"
  ) {
    return "Project";
  }
  if (normalizedScope === "user" || normalizedScope === "personal") {
    return "Personal";
  }
  if (normalizedScope) {
    return titleCaseWords(normalizedScope);
  }

  return null;
}
