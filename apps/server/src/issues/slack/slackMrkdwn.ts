/**
 * Slack mrkdwn ⇄ Markdown, as two pure functions.
 *
 * Slack's flavour is not Markdown and never was: bold is one asterisk, links are
 * `<https://example.com|label>`, mentions are `<@U123>`, and `&`, `<`, `>` arrive HTML-escaped.
 * The tracker stores Markdown — `ChatMarkdown` renders it and the composer writes it — so intake
 * has to translate on the way in, and the bot has to translate back on the way out or every
 * `**bold**` it posts reads as literal asterisks in Slack.
 *
 * Both directions leave code alone. A message that pastes a stack trace inside a fence is the
 * single most common thing a watched channel carries, and rewriting `*` inside it would corrupt
 * the one part of the message that has to survive verbatim.
 *
 * Pure on purpose: no service, no clock, no network. Everything here is exercised by
 * `slackMrkdwn.test.ts` on strings alone.
 *
 * @module issues/slack/slackMrkdwn
 */

/**
 * How long a title cut from a Slack message may be.
 *
 * Far below `ISSUE_TITLE_MAX_CHARS` (512), which is a storage ceiling rather than a reading one:
 * a triage row shows one line, and 120 characters is about where a line stops being a title and
 * starts being the message again. The tracker's own normalisation is the backstop, not this.
 */
export const SLACK_ISSUE_TITLE_MAX_CHARS = 120;

/** Where an outbound post is cut. Slack's own ceiling is 40k; a comment is not a document. */
export const SLACK_OUTBOUND_TEXT_MAX_CHARS = 2800;

/** A run of text and whether it is code, so formatting rules can skip the code. */
interface Segment {
  readonly text: string;
  readonly code: boolean;
}

/**
 * Split on fenced blocks and inline spans, keeping the delimiters with the code.
 *
 * One pass rather than two, because ``` and ` compete: a lone backtick inside a fenced block is
 * not the start of an inline span, and finding fences first is what keeps it from being read as
 * one.
 */
function splitCodeSegments(text: string): ReadonlyArray<Segment> {
  const segments: Array<Segment> = [];
  const pattern = /```[\s\S]*?```|`[^`\n]*`/g;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > index) segments.push({ text: text.slice(index, start), code: false });
    segments.push({ text: match[0], code: true });
    index = start + match[0].length;
  }
  if (index < text.length) segments.push({ text: text.slice(index), code: false });
  return segments;
}

/**
 * Slack escapes exactly these three, everywhere including inside code, and decodes nothing else:
 * `&quot;` arrives as the literal six characters and has to stay that way.
 */
function unescapeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function escapeSlackEntities(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SlackMrkdwnOptions {
  /**
   * User id → display name, for `<@U123>`. Resolving a mention needs a `users.info` call, which
   * is not something a pure function can make: the poller looks the names up and hands them in.
   * An id with no entry keeps its id rather than disappearing — a mention nobody can read is
   * still better than a sentence with a hole in it.
   */
  readonly userNames?: ReadonlyMap<string, string> | undefined;
}

/** `<...>` in Slack is always a reference of some kind, and every kind is handled here. */
function convertSlackReferences(text: string, options: SlackMrkdwnOptions): string {
  return text.replace(/<([^<>]*)>/g, (whole, inner: string) => {
    const pipeIndex = inner.indexOf("|");
    const head = pipeIndex === -1 ? inner : inner.slice(0, pipeIndex);
    const label = pipeIndex === -1 ? null : inner.slice(pipeIndex + 1);

    // `<@U123>` — a person. The label Slack sometimes supplies is already their display name.
    if (head.startsWith("@")) {
      const userId = head.slice(1);
      const name = label ?? options.userNames?.get(userId) ?? userId;
      return `@${name}`;
    }
    // `<#C123|general>` — a channel. Without a label there is only the id to show.
    if (head.startsWith("#")) return `#${label ?? head.slice(1)}`;
    // `<!here>`, `<!channel>`, `<!subteam^S123|@design>` — a broadcast or a user group.
    if (head.startsWith("!")) {
      if (label !== null) return label.startsWith("@") ? label : `@${label}`;
      const command = head.slice(1);
      const caret = command.indexOf("^");
      return `@${caret === -1 ? command : command.slice(0, caret)}`;
    }
    // A link. Slack only ever autolinks schemes it recognises, so anything else is not one.
    if (/^(https?|mailto|tel):/i.test(head)) {
      return label === null || label === head ? head : `[${label}](${head})`;
    }
    return whole;
  });
}

/**
 * Slack's single-delimiter emphasis, widened to Markdown's.
 *
 * The negative lookarounds are what keep `a_b_c` and `2 * 3 * 4` from being read as emphasis —
 * Slack applies the same rule, so a message that renders plain in Slack renders plain here.
 */
function convertSlackEmphasis(text: string): string {
  return text
    .replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "**$1**")
    .replace(/(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/g, "*$1*")
    .replace(/(?<![~\w])~(?!\s)([^~\n]+?)(?<!\s)~(?![~\w])/g, "~~$1~~");
}

/**
 * One Slack message as Markdown the tracker can store and render.
 *
 * The order is load-bearing: references are read while `&lt;` is still escaped, so a message
 * quoting `<not a link>` keeps its angle brackets instead of being parsed as one.
 */
export function slackMrkdwnToMarkdown(text: string, options: SlackMrkdwnOptions = {}): string {
  return splitCodeSegments(text)
    .map((segment) =>
      segment.code
        ? unescapeSlackEntities(segment.text)
        : unescapeSlackEntities(
            convertSlackEmphasis(convertSlackReferences(segment.text, options)),
          ),
    )
    .join("");
}

/**
 * Markdown's two emphasis strengths narrowed to Slack's, in one pass.
 *
 * One pass and not two, because the two rules feed each other: `**bold**` rewritten to `*bold*`
 * is then exactly what the italic rule is looking for, and a second pass would turn every bold
 * word italic. Alternation consumes each match once, so nothing is looked at twice.
 */
function convertMarkdownEmphasis(text: string): string {
  return text.replace(
    /(\*\*|__)(?!\s)([^\n]+?)(?<!\s)\1|(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])|(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/g,
    (whole, _fence: string | undefined, strong?: string, star?: string, underscore?: string) => {
      if (strong !== undefined) return `*${strong}*`;
      if (star !== undefined) return `_${star}_`;
      if (underscore !== undefined) return `_${underscore}_`;
      return whole;
    },
  );
}

/**
 * Markdown as Slack renders it, for everything the bot posts back.
 *
 * Escaping runs first and link building second, so the only `<` and `>` Slack sees are the ones
 * that make a link. Images are dropped to their alt text: the store they point at is on a laptop
 * behind an auth cookie, and a broken image in a thread helps nobody. A heading becomes Markdown
 * bold rather than Slack bold, so the emphasis pass below is the only thing that writes a `*`.
 */
export function markdownToSlackMrkdwn(text: string): string {
  return splitCodeSegments(text)
    .map((segment) => {
      if (segment.code) return escapeSlackEntities(segment.text);
      const escaped = escapeSlackEntities(segment.text)
        .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, "**$1**")
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_whole, alt: string) => alt)
        .replace(
          /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
          (_whole, label: string, url: string) => `<${url}|${label}>`,
        )
        .replace(/~~([^~\n]+)~~/g, "~$1~");
      return convertMarkdownEmphasis(escaped);
    })
    .join("");
}

/**
 * The first line of a message, cut to something that reads as a title.
 *
 * Markdown noise a first line often opens with — a bullet, a quote marker, a heading — is
 * stripped rather than kept: it was structure in the message and is nothing in a title. An empty
 * answer is deliberate, and means the caller should fall back; the tracker already has a word for
 * a Slack message with no text in it.
 */
export function slackTitleFromText(
  text: string,
  maxChars: number = SLACK_ISSUE_TITLE_MAX_CHARS,
): string {
  const firstLine =
    text
      .split("\n")
      .map((line) =>
        line
          .replace(/^\s*(?:[-*+]\s+|>\s*|#{1,6}\s+|\d+[.)]\s+)/, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length <= maxChars) return firstLine;

  // Cut on a word where there is one near the end, so a title does not stop mid-token.
  const window = firstLine.slice(0, maxChars - 1);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.6 ? window.slice(0, lastSpace) : window;
  return `${cut.trimEnd()}…`;
}

/** Cut an outbound post so one pasted essay does not become one unreadable Slack message. */
export function truncateForSlack(
  text: string,
  maxChars: number = SLACK_OUTBOUND_TEXT_MAX_CHARS,
): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
