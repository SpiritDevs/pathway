/**
 * The pure half of a mention-dispatched comment agent run: what the model is told, how its
 * progress is named, and how its final message is read back.
 *
 * None of this touches Effect, a repository, or a process. It lives apart from
 * `IssueCommentAgentEngineLive` for the usual reason the enrichment prompt does: the interesting
 * decisions here — when a run stops "thinking" and starts "researching", what happens to a model
 * that answers in prose when it was asked for a JSON tail — are exactly the ones worth a test that
 * does not spawn a CLI.
 *
 * @module issues/commentAgent
 */
import {
  ISSUE_COMMENT_MAX_CHARS,
  ISSUE_DESCRIPTION_MAX_CHARS,
  ISSUE_TITLE_MAX_CHARS,
  type IssueCommentAgentRunPhase,
  type IssuePriority,
} from "@t3tools/contracts";

/** How a comment is attributed in the prompt. The tracker has no names, only kinds. */
export interface CommentAgentThreadEntry {
  readonly author: string;
  readonly body: string;
  /** True for the comment whose mention started this run: the ask, rather than the history. */
  readonly isAsk: boolean;
}

export interface CommentAgentPromptInput {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly statusName: string;
  readonly priority: IssuePriority;
  readonly labelNames: ReadonlyArray<string>;
  readonly projectName: string | null;
  /** The whole thread so far, oldest first, ending with the comment that mentioned the agent. */
  readonly thread: ReadonlyArray<CommentAgentThreadEntry>;
}

const PRIORITIES: ReadonlyArray<IssuePriority> = ["none", "urgent", "high", "medium", "low"];

/** The heading the reply section is asked for, and the marker the phase heuristic watches for. */
export const COMMENT_AGENT_REPLY_HEADING = "## Reply";

/**
 * What the mentioned agent is asked.
 *
 * The shape is deliberately looser than enrichment's: that one wants a machine-readable report and
 * refuses anything else, whereas this one is answering a person in a comment thread. So the reply
 * is prose, and the structured part is an *optional* tail — a run whose model forgets the JSON
 * entirely still produces a usable answer, which is what {@link parseCommentAgentAnswer} relies on.
 */
export function buildCommentAgentPrompt(input: CommentAgentPromptInput): string {
  const lines: Array<string> = [];
  lines.push(
    "You are answering a comment on an issue in the Pathway issue tracker. Somebody mentioned",
    "you in the thread below and is waiting for a reply. Read the repository in your working",
    "directory as far as you need to answer well, and do not change any files: this is a",
    "read-only investigation, and your entire output is a comment.",
    "",
    `## ${input.key}: ${input.title}`,
    "",
    `- Status: ${input.statusName}`,
    `- Priority: ${input.priority}`,
    `- Project: ${input.projectName ?? "(none)"}`,
    `- Labels: ${input.labelNames.length === 0 ? "(none)" : input.labelNames.join(", ")}`,
    "",
    "### Description",
    "",
    input.description.trim().length === 0 ? "(empty)" : input.description,
    "",
    "### Thread",
    "",
  );

  if (input.thread.length === 0) {
    lines.push("(no comments)", "");
  }
  for (const entry of input.thread) {
    lines.push(`#### ${entry.author}${entry.isAsk ? " — this is what you were asked" : ""}`, "");
    lines.push(entry.body.trim().length === 0 ? "(empty)" : entry.body, "");
  }

  lines.push(
    "## How to answer",
    "",
    `Write your reply as markdown under a \`${COMMENT_AGENT_REPLY_HEADING}\` heading. Be direct:`,
    "the person reading it is looking at the issue, not at your transcript. Cite file paths when",
    "they help.",
    "",
    "If — and only if — the issue itself is wrong or incomplete, end your message with a fenced",
    "JSON block holding the fields you would correct:",
    "",
    "```json",
    '{ "title": "...", "description": "...", "priority": "high" }',
    "```",
    "",
    "Every field is optional and the block itself is optional. `priority` must be one of",
    `${PRIORITIES.join(", ")}. The title is only applied when the issue never got a real one, and`,
    "the description only when it is empty; suggest them anyway when they would help.",
  );

  return lines.join("\n");
}

/**
 * Whether an output chunk means the run has moved on. Phases only ever move forward: a model that
 * quotes the word "reply" while still reading files must not drag the panel back afterwards, and a
 * run that reached `replying` is assembling its answer whatever it prints next.
 *
 * A heuristic on purpose. The CLIs this reads print tool calls in half a dozen shapes and none of
 * them is a protocol; the phase is a word under a spinner, not a state machine, and being one
 * chunk late is invisible while being wrong is merely cosmetic.
 */
const RESEARCH_SIGNALS =
  /\b(bash|shell|exec|command|tool|grep|glob|rg\b|cat\b|sed\b|read(ing)?\s+file|search(ing)?|opening|apply_patch)\b/i;
const REPLY_SIGNALS =
  /(^|\n)\s{0,3}#{1,4}\s*reply\b|\bfinal answer\b|\bhere'?s my (reply|answer)\b/i;

export function nextCommentAgentPhase(
  current: IssueCommentAgentRunPhase,
  chunk: string,
): IssueCommentAgentRunPhase {
  if (current === "replying") return "replying";
  if (REPLY_SIGNALS.test(chunk)) return "replying";
  if (current === "researching") return "researching";
  return RESEARCH_SIGNALS.test(chunk) ? "researching" : "thinking";
}

/** The fields a run may propose. Absent keys are "leave it alone", never "clear it". */
export interface CommentAgentIssueUpdate {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
}

export interface CommentAgentAnswer {
  /** Markdown, posted as an ordinary comment attributed to the agent. Never empty. */
  readonly reply: string;
  readonly update?: CommentAgentIssueUpdate | undefined;
}

/** A fenced JSON block at the very end of the message, which is what the prompt asks for. */
const FENCED_TAIL = /\n?[ \t]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[\s]*$/;
/** The same tail without the fence, which is what a model that skipped the fence produces. */
const BARE_TAIL = /\n[ \t]*(\{[\s\S]*\})[\s]*$/;

/**
 * Read the model's last message back as a reply and, if it left one, a set of issue corrections.
 *
 * Lenient by design, and in one direction: anything unparseable becomes part of the reply rather
 * than a failed run. A run that spent minutes reading a repository and then forgot the JSON block
 * still answered the person who asked, and throwing that away to punish a formatting slip would be
 * the worst possible trade.
 */
export function parseCommentAgentAnswer(raw: string): CommentAgentAnswer {
  const text = raw.replace(/\r\n/g, "\n").trim();
  for (const pattern of [FENCED_TAIL, BARE_TAIL]) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const json = match[1];
    if (json === undefined) continue;
    const update = normalizeCommentAgentUpdate(parseJsonOrNull(json));
    if (update === null) continue;
    const reply = stripReplyHeading(text.slice(0, match.index));
    // A message that was *only* a JSON block still has to say something: the block is the aside,
    // and a comment with an empty body cannot be written at all.
    if (reply.length === 0) continue;
    return { reply, update };
  }
  const reply = stripReplyHeading(text);
  return { reply: reply.length === 0 ? "(the agent returned nothing)" : reply };
}

/**
 * Drop the heading the prompt asked for. It was scaffolding for the model, and a comment that
 * opens with "## Reply" is a comment shouting its own name.
 */
function stripReplyHeading(body: string): string {
  return (
    body
      .trim()
      // The `$` arm matters: a model whose whole answer was the heading has said nothing, and
      // "(the agent returned nothing)" is a better comment than one shouting "## Reply".
      .replace(/^#{1,4}[ \t]*reply[ \t]*(\r?\n+|$)/i, "")
      .trim()
      .slice(0, ISSUE_COMMENT_MAX_CHARS)
      .trim()
  );
}

/** Null when the object proposes nothing this can use, which is how a false positive backs out. */
function normalizeCommentAgentUpdate(value: unknown): CommentAgentIssueUpdate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // A model that nests its corrections under `update` or `issue` is answering the same question.
  const nested = record["update"] ?? record["issue"];
  const source =
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;

  // One line, no runs of whitespace: a title is a row in a list, whatever the model wrapped.
  const title = asString(source["title"])
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, ISSUE_TITLE_MAX_CHARS);
  const description = asString(source["description"])?.trim().slice(0, ISSUE_DESCRIPTION_MAX_CHARS);
  const rawPriority = asString(source["priority"])?.trim().toLowerCase();
  const priority = PRIORITIES.find((candidate) => candidate === rawPriority);

  const update: CommentAgentIssueUpdate = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(priority === undefined ? {} : { priority }),
  };
  return Object.keys(update).length === 0 ? null : update;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `JSON.parse`, without the throw. */
function parseJsonOrNull(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
