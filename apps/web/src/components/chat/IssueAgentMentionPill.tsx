/**
 * The rendered form of an agent mention in a comment body.
 *
 * A mention is persisted as an ordinary markdown link, `[@Claude](mention:agent:claudeAgent)`, so
 * the body stays plain markdown that anything else degrades gracefully on. Only this renderer knows
 * the href scheme means anything — and because the mention arrives as a real link node, it lands in
 * `ChatMarkdown`'s anchor component on its own. There is no text-splice pass for mentions, and
 * there must not be: the inline passes refuse `a` nodes precisely so an existing link is left alone.
 *
 * The pill does not navigate. There is nowhere to go: the mention names who ran, and the run itself
 * is rendered under the comment that started it.
 *
 * @module components/chat/IssueAgentMentionPill
 */
import { parseIssueAgentMentionHref, type ProviderDriverKind } from "@spiritdevs/contracts";
import { BotIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
} from "../composerInlineChip";
import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "../settings/providerDriverMeta";

/**
 * The href scheme the sanitizer has to keep. `rehype-sanitize` drops an href whose protocol is not
 * listed, and react-markdown's default `urlTransform` drops it a second time, so both consult this.
 */
export const ISSUE_AGENT_MENTION_PROTOCOL = "mention";

/** Same metrics as the file chip, in the accent a mention gets so the two do not read alike. */
const ISSUE_AGENT_MENTION_PILL_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-[0.33em] rounded-[0.5em] border border-primary/25 bg-primary/10 px-[0.5em] py-[0.08em] align-middle text-[12px] font-medium leading-[1.1] text-primary";

/** The agent's configured label, falling back to the link text somebody actually wrote. */
export function issueAgentMentionLabel(provider: ProviderDriverKind, writtenLabel: string): string {
  const written = writtenLabel.trim().replace(/^@+/, "").trim();
  return (
    PROVIDER_CLIENT_DEFINITION_BY_VALUE[provider]?.label ??
    (written.length > 0 ? written : provider)
  );
}

export function IssueAgentMentionPill(props: {
  readonly provider: ProviderDriverKind;
  readonly label: string;
  readonly className?: string | undefined;
}) {
  const label = props.label;
  return (
    <span
      className={cn(ISSUE_AGENT_MENTION_PILL_CLASS_NAME, props.className)}
      data-markdown-copy={`@${label}`}
      data-mention-provider={props.provider}
    >
      <BotIcon aria-hidden className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>{`@${label}`}</span>
    </span>
  );
}

/**
 * The pill for a markdown anchor, or null when the href names no agent and the anchor is an
 * ordinary link. Callers hand the link's own children in so a mention whose provider this client
 * does not recognise still prints the words that were written.
 */
export function renderIssueAgentMentionAnchor(
  href: string | undefined,
  children: ReactNode,
  className?: string | undefined,
): ReactNode | null {
  const provider = href === undefined ? null : parseIssueAgentMentionHref(href);
  if (provider === null) return null;
  return (
    <IssueAgentMentionPill
      className={className}
      label={issueAgentMentionLabel(provider, plainMentionText(children))}
      provider={provider}
    />
  );
}

/** The link's label as text. Markdown gives it as a string or a one-element array of one. */
function plainMentionText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children))
    return children.filter((child) => typeof child === "string").join("");
  return "";
}
