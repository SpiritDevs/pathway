/**
 * Pure decisions behind the comment composer's agent mention.
 *
 * A mention is typed, not compiled: somebody writes an ordinary markdown link whose text or target
 * names a configured agent — `[Claude](Claude)` — and the composer notices. The alternative entry
 * point is the picker, which adds no text at all and instead carries the choice alongside the
 * draft. Both land in the same place at submit: the body is rewritten so the mention is the
 * persisted pill syntax `[@Claude](mention:agent:claudeAgent)`, which is what the renderer draws a
 * chip from and what the server reads attribution out of.
 *
 * One mention per comment, first match wins. That is a scope decision rather than a limitation of
 * the scan: dispatching two runs off one comment would make "the reply" ambiguous, and the run
 * rides the comment as a single optional field.
 *
 * Nothing here rewrites the reader's draft. Removing a mention drops the chip and remembers the
 * token it came from; the words stay exactly as they were typed until submit, when the *body* —
 * not the draft — is normalized, because the draft is trimmed on its way to the wire and the
 * offsets a scan produces must be the ones the rewrite uses.
 *
 * @module components/issues/issueCommentMention.logic
 */
import {
  issueAgentMentionHref,
  parseIssueAgentMentionHref,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

/** One agent a comment may name, as the composer knows it: an instance, not a driver kind. */
export interface IssueCommentMentionAgent {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  /** What the picker lists and what a typed link has to match. Instance names, so "Claude 2" works. */
  readonly displayName: string;
}

/** One `[text](target)` link in the draft that names an agent, and where it sits. */
export interface IssueCommentTypedMention {
  readonly agent: IssueCommentMentionAgent;
  readonly index: number;
  readonly length: number;
  /** The matched source verbatim. Identity for a dismissal, which survives edits elsewhere. */
  readonly raw: string;
}

/** The mention the composer is currently showing, and the typed token it must replace, if any. */
export interface IssueCommentMentionResolution {
  readonly agent: IssueCommentMentionAgent;
  /** Null when the picker added the mention and the reader typed nothing. */
  readonly typed: IssueCommentTypedMention | null;
}

/** Inline links only: a mention is a word in a sentence, never a paragraph of its own. */
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;

/**
 * The comparable form of a name. Case-insensitive, and a leading `@` is decoration rather than
 * part of the name — `[@Claude](Claude)` and `[Claude](@claude)` name the same agent.
 */
export function normalizeIssueCommentMentionName(value: string): string {
  return value.trim().replace(/^@+/, "").trim().toLowerCase();
}

/**
 * Every link in the text that names a configured agent, in order.
 *
 * Two ways to name one: by display name on either side of the link, or by the persisted pill href,
 * so a body pasted back into the composer is recognised rather than mentioned twice. A link that
 * names nothing configured is left alone — it is an ordinary link, and the tracker is the filter.
 */
export function findIssueCommentAgentMentions(
  text: string,
  agents: ReadonlyArray<IssueCommentMentionAgent>,
): ReadonlyArray<IssueCommentTypedMention> {
  if (agents.length === 0) return [];
  const byName = new Map<string, IssueCommentMentionAgent>();
  const byProvider = new Map<ProviderDriverKind, IssueCommentMentionAgent>();
  for (const agent of agents) {
    const name = normalizeIssueCommentMentionName(agent.displayName);
    if (name.length > 0 && !byName.has(name)) byName.set(name, agent);
    if (!byProvider.has(agent.provider)) byProvider.set(agent.provider, agent);
  }

  const mentions: Array<IssueCommentTypedMention> = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const raw = match[0];
    const label = match[1] ?? "";
    const target = match[2] ?? "";
    const mentionedProvider = parseIssueAgentMentionHref(target.trim());
    const agent =
      (mentionedProvider === null ? undefined : byProvider.get(mentionedProvider)) ??
      byName.get(normalizeIssueCommentMentionName(label)) ??
      byName.get(normalizeIssueCommentMentionName(target));
    if (agent === undefined) continue;
    mentions.push({ agent, index: match.index, length: raw.length, raw });
  }
  return mentions;
}

/**
 * The mention state of a composer: what the chip shows, and what a submit would rewrite.
 *
 * The picker outranks the text. Somebody who typed `[Claude](Claude)` and then chose a different
 * instance in the popover means the instance they chose, and the typed token is what the pill
 * replaces — so the sentence keeps reading the way it was written, naming whoever actually ran.
 */
export function resolveIssueCommentMention(input: {
  /** The draft while typing; the *body* at submit, so offsets match the string being rewritten. */
  readonly text: string;
  readonly agents: ReadonlyArray<IssueCommentMentionAgent>;
  /** Set by the picker, and cleared when the chip is dismissed. */
  readonly pickedInstanceId: ProviderInstanceId | null;
  /** The typed token the chip was dismissed from, verbatim, so it does not come straight back. */
  readonly dismissedRaw: string | null;
}): IssueCommentMentionResolution | null {
  const typed =
    findIssueCommentAgentMentions(input.text, input.agents).find(
      (mention) => mention.raw !== input.dismissedRaw,
    ) ?? null;
  const picked =
    input.pickedInstanceId === null
      ? null
      : (input.agents.find((agent) => agent.instanceId === input.pickedInstanceId) ?? null);
  if (picked !== null) return { agent: picked, typed };
  if (typed !== null) return { agent: typed.agent, typed };
  return null;
}

/** Brackets and parens would close the link early, so a name carrying them loses them, not the pill. */
function mentionLabel(agent: IssueCommentMentionAgent): string {
  const label = agent.displayName.replace(/[[\]()]/g, "").trim();
  return label.length === 0 ? agent.provider : label;
}

/** The persisted syntax for one mention: an ordinary markdown link any renderer degrades to text. */
export function issueCommentMentionPillMarkdown(agent: IssueCommentMentionAgent): string {
  return `[@${mentionLabel(agent)}](${issueAgentMentionHref(agent.provider)})`;
}

/**
 * The body as it goes on the wire. A typed token is replaced in place — the mention stays where the
 * sentence put it — and a picker-added mention with nothing typed is prefixed, because a comment
 * addressed to somebody reads as addressed to them from its first word.
 */
export function issueCommentMentionBody(
  body: string,
  resolution: IssueCommentMentionResolution,
): string {
  const pill = issueCommentMentionPillMarkdown(resolution.agent);
  const typed = resolution.typed;
  if (typed === null) return `${pill} ${body}`;
  return `${body.slice(0, typed.index)}${pill}${body.slice(typed.index + typed.length)}`;
}

/**
 * What the chip prints under the agent's name. The model, plus whichever options the selection
 * actually pins — a boolean reads as its own name ("web search"), a string as its value ("high"),
 * because that is how the pickers label them and the chip is a summary of those pickers.
 */
export function issueCommentMentionModelSummary(selection: {
  readonly model: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
}): string {
  const values = (selection.options ?? []).flatMap((option) =>
    typeof option.value === "boolean"
      ? option.value
        ? [option.id]
        : []
      : option.value.trim().length === 0
        ? []
        : [option.value.trim()],
  );
  return values.length === 0 ? selection.model : `${selection.model} · ${values.join(" · ")}`;
}
