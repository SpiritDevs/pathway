/**
 * The text half of issue enrichment: what the model is asked, and what is made of what it says.
 *
 * Everything here is a pure function of strings and records. The process half —  spawning a
 * provider read-only in the project's directory, streaming its output into the run record, and
 * killing it on cancel — is `IssueEnrichmentEngineLive.ts`. Splitting them this way is what makes
 * the prompt, the parser, and the description block testable without a provider CLI on PATH.
 *
 * @module issues/enrichment
 */
import {
  ISSUE_DESCRIPTION_MAX_CHARS,
  ISSUE_ENRICHMENT_MAX_LIKELY_FILES,
  ISSUE_ENRICHMENT_MAX_RELATED_ISSUES,
  ISSUE_ENRICHMENT_MAX_SUGGESTED_LABELS,
  ISSUE_ENRICHMENT_SUMMARY_MAX_CHARS,
  IssueKey,
  IssuePriority,
  type IssueEnrichmentLikelyFile,
  type IssueEnrichmentResult,
  type IssueRelationDirection,
  type IssueRelationKind,
} from "@t3tools/contracts";

/** How much of a section the prompt will carry before it is cut. */
const DESCRIPTION_MAX_CHARS = 8_000;
const COMMENT_MAX_CHARS = 2_000;
const MAX_COMMENTS = 20;
const MAX_OPEN_ISSUES = 400;
/** How much of the model's output an error message quotes when it could not be parsed. */
const ERROR_TAIL_MAX_CHARS = 1_200;

const isPriority = (value: unknown): value is IssuePriority =>
  value === "none" ||
  value === "urgent" ||
  value === "high" ||
  value === "medium" ||
  value === "low";

const isIssueKey = (value: string): value is IssueKey => /^[A-Z][A-Z0-9]*-\d+$/.test(value);

function limit(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n\n[truncated]`;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** One edge on the issue being investigated, already resolved to something readable. */
export interface InvestigationRelation {
  readonly kind: IssueRelationKind;
  readonly direction: IssueRelationDirection;
  readonly key: string;
  readonly title: string;
}

export interface InvestigationComment {
  /** "Corey", "claudeAgent", "import" — whoever the change log would name. */
  readonly author: string;
  readonly body: string;
}

export interface InvestigationPromptInput {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly statusName: string;
  readonly priority: IssuePriority;
  /** The labels already on this issue, by name. */
  readonly labelNames: ReadonlyArray<string>;
  readonly todos: ReadonlyArray<{ readonly text: string; readonly done: boolean }>;
  readonly relations: ReadonlyArray<InvestigationRelation>;
  readonly comments: ReadonlyArray<InvestigationComment>;
  /**
   * Every label the tracker has. The model suggests from this set, because a label it invents is
   * one a human has to either create or ignore.
   */
  readonly availableLabels: ReadonlyArray<string>;
  /**
   * The open issues it may point at. Supplied rather than discovered: the model is reading a
   * repository, not the tracker, and a key it has not been shown is a key it made up.
   */
  readonly openIssues: ReadonlyArray<{ readonly key: string; readonly title: string }>;
}

const RELATION_LABEL: Record<`${IssueRelationKind}:${IssueRelationDirection}`, string> = {
  "blocks:outgoing": "blocks",
  "blocks:incoming": "blocked by",
  "relates:outgoing": "relates to",
  "relates:incoming": "relates to",
  "duplicate:outgoing": "duplicates",
  "duplicate:incoming": "duplicated by",
};

function section(heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> {
  return lines.length === 0 ? [] : ["", heading, ...lines];
}

/**
 * The whole instruction set, as one string on stdin.
 *
 * Ordered instructions first, context second: every provider here is a coding agent that will
 * start reading files as soon as it has a task, and putting the output contract last has it
 * discovered after the work rather than before it.
 */
export function buildInvestigationPrompt(input: InvestigationPromptInput): string {
  const description = input.description.trim();
  const openIssues = input.openIssues.slice(0, MAX_OPEN_ISSUES);

  return [
    "You are investigating one issue in a repository you can read but must not change.",
    "Read whatever files you need. Do not edit, create, delete, or run anything that writes.",
    "",
    "Produce, in this order:",
    "1. A restatement of the problem in your own words, concrete about what is wrong and where.",
    "2. The files the work most likely lands in, each with a one-line reason it is on the list.",
    "3. Which of the open issues listed below are genuinely related, by key.",
    "4. Which of the existing labels listed below apply.",
    "5. A priority.",
    "",
    "Answer with a single JSON object and nothing else. No prose before or after it, no code",
    "fence. The object has exactly these keys:",
    '  "summary": string — the restated problem, markdown, a few paragraphs at most',
    '  "likelyFiles": array of { "path": string, "reason": string } — repository-relative paths',
    `  "relatedIssueKeys": array of string — keys taken only from the open issues below`,
    `  "suggestedLabels": array of string — names taken only from the existing labels below`,
    '  "suggestedPriority": "urgent" | "high" | "medium" | "low" | "none" | null',
    "",
    "Use an empty array where you have nothing to say. Do not invent an issue key or a label name",
    "that is not on the lists. Nothing you suggest is applied automatically; a person reviews it.",
    "",
    "---",
    "",
    `Issue ${input.key}: ${input.title}`,
    `Status: ${input.statusName}`,
    `Priority: ${input.priority}`,
    `Labels: ${input.labelNames.length > 0 ? input.labelNames.join(", ") : "(none)"}`,
    "",
    "Description:",
    description.length > 0 ? limit(description, DESCRIPTION_MAX_CHARS) : "(empty)",
    ...section(
      "Checklist:",
      input.todos.map((todo) => `- [${todo.done ? "x" : " "}] ${todo.text}`),
    ),
    ...section(
      "Relations:",
      input.relations.map(
        (relation) =>
          `- ${RELATION_LABEL[`${relation.kind}:${relation.direction}`]} ${relation.key}: ${relation.title}`,
      ),
    ),
    ...section(
      "Comments, oldest first:",
      input.comments
        .slice(-MAX_COMMENTS)
        .map((comment) => `- ${comment.author}: ${limit(comment.body.trim(), COMMENT_MAX_CHARS)}`),
    ),
    ...section(
      "Existing labels:",
      input.availableLabels.map((label) => `- ${label}`),
    ),
    ...section(
      "Open issues:",
      openIssues.map((issue) => `- ${issue.key}: ${issue.title}`),
    ),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing what came back
// ---------------------------------------------------------------------------

/**
 * The last balanced JSON object in a blob of model output, or null.
 *
 * The *last* one, deliberately. An investigation transcript routinely quotes JSON on the way to
 * its answer — a `package.json` fragment, a tool result, an example of the format it was asked
 * for — and the answer is what came out at the end. Fences are stripped first because a model
 * told "no code fence" produces one about a third of the time.
 */
export function extractLastJsonObject(raw: string): string | null {
  const withoutFences = raw.replace(/^[ \t]*```[^\n]*\n?|```[ \t]*$/gm, "");

  // Walked from the end: every closing brace is a candidate, and the first one whose match is
  // balanced back to a `{` wins. Scanning forwards would return the first object instead.
  for (let end = withoutFences.length - 1; end >= 0; end -= 1) {
    if (withoutFences[end] !== "}") continue;
    const start = matchingOpenBrace(withoutFences, end);
    if (start !== null) {
      return withoutFences.slice(start, end + 1);
    }
  }
  return null;
}

/** Walk back from a `}` to its `{`, respecting strings and escapes. Null if it never balances. */
function matchingOpenBrace(text: string, end: number): number | null {
  let depth = 0;
  for (let index = end; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '"' && !isEscaped(text, index)) {
      const stringStart = openingQuote(text, index);
      if (stringStart === null) return null;
      index = stringStart;
      continue;
    }
    if (char === "}") {
      depth += 1;
      continue;
    }
    if (char === "{") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** From a closing quote, the index of the quote that opened the string. */
function openingQuote(text: string, closing: number): number | null {
  for (let index = closing - 1; index >= 0; index -= 1) {
    if (text[index] === '"' && !isEscaped(text, index)) {
      return index;
    }
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function normalizeLikelyFiles(value: unknown): ReadonlyArray<IssueEnrichmentLikelyFile> {
  const files: Array<IssueEnrichmentLikelyFile> = [];
  for (const entry of asArray(value)) {
    if (files.length >= ISSUE_ENRICHMENT_MAX_LIKELY_FILES) break;
    // A bare string is a common shape when the model forgets the reason; it is still a useful
    // pointer, so it lands with an empty reason rather than being dropped.
    const path = (typeof entry === "string" ? entry : asString((entry as never)?.["path"]))?.trim();
    if (!path) continue;
    const reason =
      typeof entry === "string" ? "" : (asString((entry as never)?.["reason"])?.trim() ?? "");
    files.push({ path, reason });
  }
  return files;
}

/**
 * Turn whatever the model produced into an {@link IssueEnrichmentResult}, or null.
 *
 * Only `summary` is load-bearing: a run with no restated problem produced nothing worth appending
 * to a description, and that is the one case this refuses. Everything else is clamped rather than
 * rejected — an extra likely file or a label the tracker does not have is not a reason to throw
 * away a run that took minutes and real tokens.
 *
 * `knownIssueKeys` and `knownLabels` are the model's vocabulary. Anything outside them is dropped:
 * a key that resolves to nothing renders as a dead link, and a suggested label nobody defined is
 * a chore rather than a suggestion.
 */
export function normalizeInvestigationResult(
  value: unknown,
  vocabulary: {
    readonly knownIssueKeys: ReadonlySet<string>;
    readonly knownLabels: ReadonlyArray<string>;
  },
): IssueEnrichmentResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const summary = asString(record["summary"])?.trim();
  if (!summary) return null;

  const labelsByLowercase = new Map(
    vocabulary.knownLabels.map((label) => [label.toLowerCase(), label] as const),
  );

  const relatedIssueKeys: Array<IssueKey> = [];
  for (const entry of asArray(record["relatedIssueKeys"])) {
    if (relatedIssueKeys.length >= ISSUE_ENRICHMENT_MAX_RELATED_ISSUES) break;
    const key = asString(entry)?.trim().toUpperCase();
    if (!key || !isIssueKey(key)) continue;
    if (!vocabulary.knownIssueKeys.has(key)) continue;
    if (relatedIssueKeys.includes(key)) continue;
    relatedIssueKeys.push(key);
  }

  const suggestedLabels: Array<string> = [];
  for (const entry of asArray(record["suggestedLabels"])) {
    if (suggestedLabels.length >= ISSUE_ENRICHMENT_MAX_SUGGESTED_LABELS) break;
    // Matched case-insensitively but stored as the tracker spells it, so the panel's "apply"
    // button has a name that resolves to an existing label rather than creating a near-duplicate.
    const canonical = labelsByLowercase.get(asString(entry)?.trim().toLowerCase() ?? "");
    if (!canonical || suggestedLabels.includes(canonical)) continue;
    suggestedLabels.push(canonical);
  }

  const priority = record["suggestedPriority"];
  return {
    summary: summary.slice(0, ISSUE_ENRICHMENT_SUMMARY_MAX_CHARS),
    likelyFiles: normalizeLikelyFiles(record["likelyFiles"]),
    relatedIssueKeys,
    suggestedLabels,
    suggestedPriority: isPriority(priority) ? priority : null,
  };
}

/**
 * The end of the model's output, for the error on a run that could not be parsed.
 *
 * The end rather than the beginning: whatever went wrong went wrong where the answer should have
 * been, and the first thousand characters of an investigation are the model reading files.
 */
export function investigationErrorTail(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length <= ERROR_TAIL_MAX_CHARS
    ? trimmed
    : `…${trimmed.slice(trimmed.length - ERROR_TAIL_MAX_CHARS)}`;
}

// ---------------------------------------------------------------------------
// The block that lands on the description
// ---------------------------------------------------------------------------

/** The heading every investigation block starts with, and the marker that finds one again. */
export const INVESTIGATION_BLOCK_HEADING = "## Investigation";

export interface InvestigationBlockInput {
  readonly result: IssueEnrichmentResult;
  /** What ran it, as the run row recorded it — `codex / gpt-5.4-codex`. */
  readonly model: string;
  /** ISO instant the run finished. Rendered as a calendar day; the exact second is in the run. */
  readonly finishedAt: string;
}

/**
 * Render a finished investigation as markdown.
 *
 * Suggestions are listed, never applied. The label and priority lines exist so the description
 * says what was proposed even after the run panel is closed — taking them up is a human's write,
 * through the ordinary update path, attributed to the human.
 */
export function buildInvestigationBlock(input: InvestigationBlockInput): string {
  const day = input.finishedAt.slice(0, 10);
  const { result } = input;

  const suggestions = [
    result.suggestedLabels.length > 0 ? `Labels: ${result.suggestedLabels.join(", ")}` : null,
    result.suggestedPriority !== null ? `Priority: ${result.suggestedPriority}` : null,
  ].filter((line): line is string => line !== null);

  return [
    `${INVESTIGATION_BLOCK_HEADING} (${input.model}, ${day})`,
    "",
    result.summary.trim(),
    ...section(
      "**Likely files**",
      result.likelyFiles.map((file) =>
        file.reason.trim().length > 0
          ? `- \`${file.path}\` — ${file.reason}`
          : `- \`${file.path}\``,
      ),
    ),
    ...section(
      "**Related issues**",
      result.relatedIssueKeys.length > 0 ? [result.relatedIssueKeys.join(", ")] : [],
    ),
    ...section(
      "**Suggested** (not applied)",
      suggestions.map((line) => `- ${line}`),
    ),
  ].join("\n");
}

/** What separates a block from whatever is already on the description. */
const INVESTIGATION_BLOCK_SEPARATOR = "\n\n---\n\n";
const INVESTIGATION_TRUNCATION_NOTE = "\n\n[truncated]";
/**
 * The smallest block worth appending. Under this there is no room for a heading and a sentence,
 * and a stub that says nothing is worse on a description than nothing at all.
 */
const MIN_INVESTIGATION_BLOCK_CHARS = 400;

/** Cut a block to a hard budget, with the note counted *inside* it rather than added past it. */
function clampInvestigationBlock(block: string, budget: number): string {
  if (block.length <= budget) return block;
  const room = budget - INVESTIGATION_TRUNCATION_NOTE.length;
  return room <= 0
    ? block.slice(0, Math.max(0, budget))
    : `${block.slice(0, room)}${INVESTIGATION_TRUNCATION_NOTE}`;
}

/**
 * Append an investigation block to a description, within the bound a description has.
 *
 * Appended, never replacing: two runs on one issue are two readings of a tree that moved between
 * them, and the older one is the record of what was true then. A horizontal rule separates the
 * block from whatever a human wrote above it.
 *
 * The bound is the load-bearing part. `IssuePatch.description` refuses anything over
 * {@link ISSUE_DESCRIPTION_MAX_CHARS} at the wire, but this write reaches the service directly,
 * so nothing else would stop the tenth investigation on one issue from producing a description no
 * client can ever send back — the editor round-trips the whole body, so one character over the
 * limit makes the field permanently unsavable. Whatever a human wrote is never touched: the block
 * is cut to the room that is left, and when there is not enough room for a readable one the
 * description is returned unchanged. Nothing is lost either way — the result lives on the run row,
 * which is what the panel renders.
 */
export function appendInvestigationBlock(
  description: string,
  block: string,
  maxChars: number = ISSUE_DESCRIPTION_MAX_CHARS,
): string {
  const body = description.replace(/\s+$/, "");
  if (body.length === 0) return clampInvestigationBlock(block, maxChars);

  const budget = maxChars - body.length - INVESTIGATION_BLOCK_SEPARATOR.length;
  // Returned as it came in, not as `body`: an unchanged string is a no-op patch, and the update
  // path skips it without writing a change-log row that would claim the description moved.
  if (budget < MIN_INVESTIGATION_BLOCK_CHARS) return description;
  return `${body}${INVESTIGATION_BLOCK_SEPARATOR}${clampInvestigationBlock(block, budget)}`;
}
