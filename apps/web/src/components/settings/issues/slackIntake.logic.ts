/**
 * Pure decisions behind Settings → Issues → Triage & Intake.
 *
 * The page is a token field and a table of watched channels, and almost everything it has to
 * decide is a string: what a trigger combination reads as, whether a hand-typed emoji or channel
 * id is one Slack would recognise, and what the poller's health is saying. None of that needs a
 * connection, so none of it lives in the panel.
 *
 * @module components/settings/issues/slackIntake.logic
 */
import {
  SLACK_MAX_CHANNEL_WATCHES,
  isSlackIntakeTriggerActive,
  type SlackChannelRef,
  type SlackChannelWatch,
  type SlackIntakeStatus,
  type SlackIntakeTrigger,
} from "@t3tools/contracts";

import { formatIssueAge } from "../../issues/triage.logic";

/**
 * The scopes the bot token needs, in the order the Slack app's scope screen lists them. Shown
 * rather than checked: the server finds out which one is missing when a call fails, and by then
 * the token is already pasted.
 */
export const SLACK_BOT_TOKEN_SCOPES: ReadonlyArray<string> = [
  "channels:history",
  "channels:read",
  "chat:write",
  "users:read",
  "reactions:read",
  "files:read",
];

/** A watch with nothing switched on. What "Add channel" creates, and what pausing one leaves. */
export const PAUSED_SLACK_TRIGGER: SlackIntakeTrigger = Object.freeze({
  emoji: null,
  everyMessage: false,
  botMention: false,
});

/**
 * What a channel's trigger combination reads as in the table.
 *
 * All three off is "Paused", not "No triggers": the row is still watched and still remembers how
 * it was configured, and a channel that files nothing on purpose is a pause rather than a mistake.
 */
export function slackTriggerSummary(trigger: SlackIntakeTrigger): string {
  if (!isSlackIntakeTriggerActive(trigger)) return "Paused";
  const parts: Array<string> = [];
  if (trigger.emoji !== null) parts.push(`:${trigger.emoji}:`);
  if (trigger.everyMessage) parts.push("Every message");
  if (trigger.botMention) parts.push("Bot mentions");
  return parts.join(" · ");
}

// ── Emoji ──────────────────────────────────────────────────────────────

/**
 * What a typed reaction name becomes. Colons are stripped because everybody types them and Slack
 * stores none: the poller compares this against `reaction.name` verbatim, so `:ticket:` would
 * match nothing at all.
 */
export function normalizeSlackEmojiName(raw: string): string {
  return raw.trim().replace(/^:+/, "").replace(/:+$/, "").trim().toLowerCase();
}

/** Mirrors `SlackEmojiName`'s pattern, so a bad name is a field error and not a refused write. */
export function slackEmojiNameError(raw: string): string | null {
  const name = normalizeSlackEmojiName(raw);
  if (name.length === 0) return "Enter a reaction name, or turn the reaction trigger off.";
  if (!/^[a-z0-9_+-]+$/.test(name)) {
    return "Reaction names are lower case letters, digits, and _ + - only.";
  }
  return null;
}

// ── Channels ───────────────────────────────────────────────────────────

/** `#design` and ` design ` are the same channel to a person; the stored name is neither. */
export function normalizeSlackChannelName(raw: string): string {
  return raw.trim().replace(/^#+/, "").trim();
}

/**
 * A channel id as Slack mints them: `C` for a public channel, `G` for a private one, `D` for a DM,
 * then upper-case alphanumerics. Only checked for the manual fallback field — the picker's ids came
 * from Slack, so they are right by construction.
 */
export function slackChannelIdError(raw: string): string | null {
  const id = raw.trim();
  if (id.length === 0) return "Enter a channel id.";
  if (!/^[CGD][A-Z0-9]{2,}$/.test(id)) {
    return "A channel id looks like C0123ABCD. Copy it from the channel's About tab.";
  }
  return null;
}

/**
 * The channels the picker may still offer. A channel already watched is dropped rather than
 * disabled: picking it would be refused as a conflict, and two watches on one channel would poll
 * it twice and file everything twice.
 */
export function unwatchedSlackChannels(
  channels: ReadonlyArray<SlackChannelRef>,
  watches: ReadonlyArray<SlackChannelWatch>,
): ReadonlyArray<SlackChannelRef> {
  const watched = new Set(watches.map((watch) => watch.channelId));
  return channels.filter((channel) => !watched.has(channel.id));
}

/** Null when another channel may be watched, or the sentence the Add button is disabled with. */
export function slackWatchLimitError(watches: ReadonlyArray<SlackChannelWatch>): string | null {
  return watches.length >= SLACK_MAX_CHANNEL_WATCHES
    ? `You can watch ${SLACK_MAX_CHANNEL_WATCHES} channels. Every watch costs a Slack call every poll.`
    : null;
}

// ── Connection health ──────────────────────────────────────────────────

export type SlackConnectionTone = "idle" | "connected" | "error";

export interface SlackConnectionSummary {
  readonly tone: SlackConnectionTone;
  readonly headline: string;
  /** One sentence under the headline. Null when there is nothing more to say. */
  readonly detail: string | null;
}

/**
 * What the connection card says.
 *
 * `lastPollAt` and `lastError` are per-boot, so a server that has been asleep for a week reports a
 * token and no poll — which is the truth, and reads as "waiting for the first poll" rather than as
 * a fault.
 */
export function slackConnectionSummary(
  status: SlackIntakeStatus,
  nowMs: number,
): SlackConnectionSummary {
  if (!status.configured) {
    return {
      tone: "idle",
      headline: "Not connected",
      detail: "Paste a bot token to start polling the channels you watch.",
    };
  }
  const workspace = status.workspaceName === null ? "Slack" : status.workspaceName;
  if (status.lastError !== null) {
    return { tone: "error", headline: `Connected to ${workspace}`, detail: status.lastError };
  }
  if (status.lastPollAt === null) {
    return {
      tone: "connected",
      headline: `Connected to ${workspace}`,
      detail: "No poll yet since this server woke up.",
    };
  }
  const age = formatIssueAge(status.lastPollAt, nowMs);
  return {
    tone: "connected",
    headline: `Connected to ${workspace}`,
    detail: age === "now" ? "Polled just now." : `Polled ${age} ago.`,
  };
}
