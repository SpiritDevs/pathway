/**
 * The text half of issue enrichment: what the model is asked, and what is made of what it says.
 *
 * Everything here is a pure function of strings and records. The process half —  spawning a
 * provider read-only in the project's directory, streaming its output into the run record, and
 * killing it on cancel — is `IssueEnrichmentEngineLive.ts`. Splitting them this way is what makes
 * the prompt, the parser, and the investigation comment testable without a provider CLI on PATH.
 *
 * @module issues/enrichment
 */
import {
  ISSUE_ENRICHMENT_MAX_LIKELY_FILES,
  ISSUE_ENRICHMENT_MAX_RELATED_ISSUES,
  ISSUE_ENRICHMENT_MAX_SUGGESTED_LABELS,
  ISSUE_ENRICHMENT_SUMMARY_MAX_CHARS,
  ISSUE_TITLE_MAX_CHARS,
  IssueKey,
  IssuePriority,
  type IssueEnrichmentLikelyFile,
  type IssueEnrichmentResult,
  type IssueRelationDirection,
  type IssueRelationKind,
} from "@spiritdevs/contracts";

/** How much of a section the prompt will carry before it is cut. */
const DESCRIPTION_MAX_CHARS = 8_000;
const COMMENT_MAX_CHARS = 2_000;
const MAX_COMMENTS = 20;
const MAX_OPEN_ISSUES = 400;
/** How long a proposed description may be. A body for an empty issue, not a report. */
const SUGGESTED_DESCRIPTION_MAX_CHARS = 8_000;
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

/** What the provider was handed alongside the prompt, counted. */
export interface InvestigationImageSummary {
  /** How many image files ride along with this request. */
  readonly provided: number;
  /**
   * How many of the issue's other attachments were left behind — over the cap, in a format no
   * provider reads, or missing from the store. Counted rather than described: the model can do
   * nothing about any of those, and "there is more" is the only part it can act on.
   */
  readonly omitted: number;
}

export interface InvestigationPromptInput {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  /** Slack supplied the initial title and body, so the investigation may refine the title. */
  readonly slackIngested?: boolean | undefined;
  readonly statusName: string;
  readonly priority: IssuePriority;
  /** The labels already on this issue, by name. */
  readonly labelNames: ReadonlyArray<string>;
  readonly todos: ReadonlyArray<{ readonly text: string; readonly done: boolean }>;
  readonly relations: ReadonlyArray<InvestigationRelation>;
  readonly comments: ReadonlyArray<InvestigationComment>;
  /**
   * The images attached to the request, counted. A model cannot tell how many pictures it was
   * given from the pictures alone, and an issue reported with a screenshot has its whole report
   * in one — so the prompt says how many arrived, and how many did not.
   *
   * Only ever set by a caller that is genuinely sending the files to a provider that reads them.
   * Left out for one that is not: a sentence about attachments no model can see is worse than
   * silence, because it invites the model to reason about evidence it does not have.
   */
  readonly images?: InvestigationImageSummary | undefined;
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

function investigationImageLines(
  images: InvestigationImageSummary | undefined,
): ReadonlyArray<string> {
  if (images === undefined || images.provided <= 0) return [];
  return [
    `- ${images.provided} image attachment(s) from this issue are provided with this request.`,
    "  Look at them: for an issue reported as a screenshot they are the report.",
    ...(images.omitted > 0
      ? [`- ${images.omitted} more attachment(s) on this issue were not included.`]
      : []),
  ];
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
    "6. A title and a description where the issue rules below allow them.",
    "",
    "Answer with a single JSON object and nothing else. No prose before or after it, no code",
    "fence. The object has these keys:",
    '  "summary": string — the restated problem, markdown, a few paragraphs at most',
    '  "likelyFiles": array of { "path": string, "reason": string } — repository-relative paths',
    `  "relatedIssueKeys": array of string — keys taken only from the open issues below`,
    `  "suggestedLabels": array of string — names taken only from the existing labels below`,
    '  "suggestedPriority": "urgent" | "high" | "medium" | "low" | "none" | null',
    '  "suggestedTitle": string — optional, and omitted entirely unless it applies',
    '  "suggestedDescription": string — optional, and omitted entirely unless it applies',
    "",
    "Use an empty array where you have nothing to say. Do not invent an issue key or a label name",
    "that is not on the lists. Priority and safe missing-field suggestions may be applied",
    "automatically after the run; labels remain for a person to review.",
    "The summary is appended to the issue description after the run. Write it as a useful,",
    "standalone explanation of the work; do not merely repeat the issue's source text.",
    "",
    ...(input.slackIngested
      ? [
          'This issue was ingested from Slack. Include "suggestedTitle" even though it already has',
          "a title: Slack generated that title from the first line, and your title should state the",
          "specific job to be done. A later user edit is protected when the result is applied.",
        ]
      : [
          'Include "suggestedTitle" only when the title above is one of the intake placeholders —',
          '"Slack message", "Untitled", "New issue", or empty. Otherwise leave the key out; a title a',
          "person wrote is not up for replacement, however uninformative it reads.",
        ]),
    "When you do include it: one line, concise, descriptive of the problem, no trailing punctuation.",
    'Include "suggestedDescription" only when the description above is empty or near-empty.',
    "Otherwise leave the key out. When you do include it: concise markdown, built strictly from the",
    "context given here — the comments, the attachments, what you read in the repository. Never",
    "invent a detail, a repro step, or an expected behaviour that nothing above states.",
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
    ...section("Attachments:", investigationImageLines(input.images)),
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

/** One line, no runs of whitespace: a title is a row in a list, whatever the model wrapped. */
function normalizeSuggestedTitle(value: unknown): string | null {
  const title = asString(value)?.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.slice(0, ISSUE_TITLE_MAX_CHARS).trim();
}

function normalizeSuggestedDescription(value: unknown): string | null {
  const description = asString(value)?.trim();
  if (!description) return null;
  return description.slice(0, SUGGESTED_DESCRIPTION_MAX_CHARS).trim();
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
 *
 * `currentTitle` and `currentDescription` drop a suggestion that proposes what the issue already
 * says. Title provenance is deliberately not decided here: the issue may be edited while the run
 * is working, so the completion path uses the live title and its latest actor to decide between
 * automatic application and a reviewable suggestion.
 */
export function normalizeInvestigationResult(
  value: unknown,
  vocabulary: {
    readonly knownIssueKeys: ReadonlySet<string>;
    readonly knownLabels: ReadonlyArray<string>;
    readonly currentTitle?: string;
    readonly currentDescription?: string;
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

  const suggestedTitle = normalizeSuggestedTitle(record["suggestedTitle"]);
  const suggestedDescription = normalizeSuggestedDescription(record["suggestedDescription"]);
  const currentTitle = vocabulary.currentTitle?.replace(/\s+/g, " ").trim();
  const currentDescription = vocabulary.currentDescription?.trim();

  const priority = record["suggestedPriority"];
  return {
    summary: summary.slice(0, ISSUE_ENRICHMENT_SUMMARY_MAX_CHARS),
    likelyFiles: normalizeLikelyFiles(record["likelyFiles"]),
    relatedIssueKeys,
    suggestedLabels,
    suggestedPriority: isPriority(priority) ? priority : null,
    // Written as absent keys rather than `undefined` values: the result is stored as JSON, and a
    // suggestion nobody made should not read as one the model declined to make.
    ...(suggestedTitle !== null && suggestedTitle !== currentTitle ? { suggestedTitle } : {}),
    ...(suggestedDescription !== null && suggestedDescription !== currentDescription
      ? { suggestedDescription }
      : {}),
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
// The comment a completed investigation leaves behind
// ---------------------------------------------------------------------------

/** The heading every investigation comment starts with. */
export const INVESTIGATION_BLOCK_HEADING = "## Investigation";

export interface InvestigationBlockInput {
  readonly result: IssueEnrichmentResult;
  /** What ran it, as the run row recorded it — `codex / gpt-5.4-codex`. */
  readonly model: string;
  /** ISO instant the run finished. Rendered as a calendar day; the exact second is in the run. */
  readonly finishedAt: string;
}

/**
 * Render a finished investigation as a Markdown comment.
 *
 * Suggestions are listed as the model returned them. Automatic field changes also appear in the
 * activity feed; labels remain reviewable in the investigation panel.
 */
export function buildInvestigationComment(input: InvestigationBlockInput): string {
  const day = input.finishedAt.slice(0, 10);
  const { result } = input;

  const suggestedTitle = result.suggestedTitle?.trim() ?? "";
  const suggestedDescription = result.suggestedDescription?.trim() ?? "";

  const suggestions = [
    suggestedTitle.length > 0 ? `Title: ${suggestedTitle}` : null,
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
    ...section("**Suggested**", [
      ...suggestions.map((line) => `- ${line}`),
      // Quoted rather than fenced: a proposed description is markdown itself, and a fence around
      // a fence renders as neither. The blank line keeps it off the bullet above it.
      ...(suggestedDescription.length > 0
        ? [
            "- Description:",
            "",
            ...suggestedDescription
              .split("\n")
              .map((line) => (line.length > 0 ? `> ${line}` : ">")),
          ]
        : []),
    ]),
  ].join("\n");
}
