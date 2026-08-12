/**
 * SlackIntakePoller - the loop that reads watched channels, and the loop that answers them.
 *
 * This is the half of intake that runs on its own. It requires both `IssueTrackerService` and
 * `SlackIntakeEngine`, which is exactly why it is a third layer rather than part of either: the
 * tracker requires the engine, so anything the tracker requires cannot require the tracker back.
 * Nothing requires the poller, so the poller may require everything.
 *
 * Five things are worth understanding before reading the code.
 *
 * - **Polling, not sockets.** Decision 0006 chose `conversations.history` from a stored cursor
 *   because this server sleeps. A socket that was not connected on Tuesday heard nothing on
 *   Tuesday; a cursor read on Wednesday catches all of it up.
 *
 * - **A cursor cannot see a reaction.** Adding :ticket: to last week's message does not put that
 *   message back at the top of the history. So every channel with an emoji trigger gets a second,
 *   bounded pass over recent history — the smaller of a hundred messages and seven days — looking
 *   for the trigger on messages that have not become issues yet. `reaction_scan_ts` is the floor
 *   of that window and trails the main cursor on purpose.
 *
 * - **A watch starts from now.** The first poll of a channel writes the cursor and files nothing.
 *   Filing a channel's entire history the moment somebody watches it would put hundreds of triage
 *   items in front of them, and the reaction window starts at the same place for the same reason.
 *
 * - **Echo suppression is the outbound registry, twice over.** Every message the bot posts is
 *   recorded by ts before the next cycle can read it, and every message carrying a `bot_id` is
 *   skipped anyway. Either alone would do; both means a lost race still cannot loop.
 *
 * - **One broken channel is one broken channel.** Every channel's pass is caught on its own, so a
 *   bot removed from #design does not stop #support from being read. The first failure of a cycle
 *   is what the status line reports.
 *
 * @module issues/slack/SlackIntakePoller
 */
import {
  ISSUE_COMMENT_MAX_ATTACHMENTS,
  isSlackIntakeTriggerActive,
  type Issue,
  type IssueActor,
  type IssueId,
  type IssuesStreamEvent,
  type SlackChannelWatch,
  type SlackIntakeTrigger,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { IssueEventRepository } from "../../persistence/Services/IssueEvents.ts";
import { SlackChannelWatchRepository } from "../../persistence/Services/SlackChannelWatches.ts";
import { SlackIntakeLedgerRepository } from "../../persistence/Services/SlackIntakeLedger.ts";
import { forkParked } from "../../serverActivation.ts";
import { IssueTrackerService } from "../IssueTrackerService.ts";
import {
  SlackApiClient,
  type SlackFile,
  type SlackHistoryPage,
  type SlackIdentity,
  type SlackMessage,
} from "./SlackApiClient.ts";
import { SlackIntakeEngine } from "./SlackIntakeEngine.ts";
import { SlackIntakeSignal } from "./SlackIntakeSignal.ts";
import {
  markdownToSlackMrkdwn,
  slackMrkdwnToMarkdown,
  slackTitleFromText,
  truncateForSlack,
} from "./slackMrkdwn.ts";
import { readSlackBotToken } from "./slackToken.ts";

/** Decision 0006's number. One history call per watched channel per interval, forever. */
export const SLACK_POLL_INTERVAL_MS = 30_000;

/** How far back a reaction can be noticed. Past this, adding the emoji does nothing. */
export const SLACK_REACTION_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/** And how many messages of that window are looked at, whichever bound bites first. */
export const SLACK_REACTION_WINDOW_MESSAGES = 100;

/**
 * Pages of backlog one channel may catch up on in one pass.
 *
 * Two thousand messages is a week of a busy channel. Past that the cursor still advances to what
 * was read, so the next pass — thirty seconds later — takes the next two thousand.
 */
export const SLACK_MAX_HISTORY_PAGES = 10;

/**
 * Message subtypes worth reading. Everything else in a channel's history — joins, topic changes,
 * pinned notices, edits of messages already seen — is chrome, and filing it would be noise.
 */
const READABLE_SUBTYPES: ReadonlySet<string> = new Set(["file_share"]);

/**
 * How the human is named in a Slack thread.
 *
 * The tracker's `user` actor carries no identity — this environment has exactly one person and
 * nothing to tell them apart by — so there is no name to use. Naming the app rather than guessing
 * at the person is the honest option, and "Pathway user moved PAT-12 to In Review" at least says
 * a person did it rather than an agent.
 */
const SLACK_USER_ACTOR_LABEL = "Pathway user";

const SLACK_SYSTEM_ACTOR_LABELS: Record<"import" | "cycles" | "slack", string> = {
  import: "CSV import",
  cycles: "Cycle rollover",
  slack: "Slack",
};

/** Who to say did it, in a sentence a Slack reader can follow. */
export function slackActorLabel(actor: IssueActor): string {
  switch (actor.kind) {
    case "user":
      return SLACK_USER_ACTOR_LABEL;
    case "agent":
      return actor.provider.charAt(0).toUpperCase() + actor.provider.slice(1);
    case "system":
      return SLACK_SYSTEM_ACTOR_LABELS[actor.source];
  }
}

/**
 * Order two Slack timestamps.
 *
 * String order is wrong across a digit boundary and `parseFloat` is wrong in the last place —
 * `1723459200.001900` needs more significant digits than a double has. Seconds and microseconds
 * are two integers, so they are compared as two integers.
 */
export function compareSlackTs(left: string, right: string): number {
  const [leftSeconds = "0", leftFraction = ""] = left.split(".");
  const [rightSeconds = "0", rightFraction = ""] = right.split(".");
  const leftWhole = Number.parseInt(leftSeconds, 10) || 0;
  const rightWhole = Number.parseInt(rightSeconds, 10) || 0;
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;
  const leftMicros = Number.parseInt(leftFraction.padEnd(6, "0").slice(0, 6) || "0", 10) || 0;
  const rightMicros = Number.parseInt(rightFraction.padEnd(6, "0").slice(0, 6) || "0", 10) || 0;
  if (leftMicros === rightMicros) return 0;
  return leftMicros < rightMicros ? -1 : 1;
}

const laterTs = (left: string | null, right: string | null): string | null => {
  if (left === null) return right;
  if (right === null) return left;
  return compareSlackTs(left, right) >= 0 ? left : right;
};

/** A Slack timestamp for a wall-clock instant, which is all `oldest` is ever compared against. */
const slackTsFromMillis = (millis: number): string => `${Math.floor(millis / 1000)}.000000`;

/**
 * Whether this message came from an app rather than a person.
 *
 * Every bot, not only this one. Our own posts are already in the outbound ledger, so this is the
 * belt to that registry's braces; other apps are skipped because a channel that files every
 * message would otherwise turn a deploy notifier into a triage queue.
 */
function isBotMessage(message: SlackMessage, identity: SlackIdentity): boolean {
  if (message.subtype === "bot_message") return true;
  if (message.bot_id !== undefined && message.bot_id.length > 0) return true;
  if (message.app_id !== undefined && message.app_id.length > 0) return true;
  return identity.botUserId !== null && message.user === identity.botUserId;
}

/** A message that is a reply carries its parent's ts; the parent carries its own. */
function isThreadReply(message: SlackMessage): boolean {
  return message.thread_ts !== undefined && message.thread_ts !== message.ts;
}

function isReadableMessage(message: SlackMessage): boolean {
  return message.subtype === undefined || READABLE_SUBTYPES.has(message.subtype);
}

/**
 * Whether this message is one the watch wanted.
 *
 * Any of the three, not all: a channel can file on a mention *and* on a reaction. Skin tones ride
 * on the reaction name (`+1::skin-tone-3`), so the comparison is against the base name.
 */
export function messageMatchesTrigger(
  trigger: SlackIntakeTrigger,
  message: SlackMessage,
  identity: SlackIdentity,
): boolean {
  if (trigger.everyMessage) return true;
  if (
    trigger.botMention &&
    identity.botUserId !== null &&
    (message.text ?? "").includes(`<@${identity.botUserId}>`)
  ) {
    return true;
  }
  return trigger.emoji !== null && messageHasReaction(message, trigger.emoji);
}

export function messageHasReaction(message: SlackMessage, emoji: string): boolean {
  return (message.reactions ?? []).some(
    (reaction) => reaction.name === emoji || reaction.name.split("::")[0] === emoji,
  );
}

/** Slack's file list, narrowed to the images the attachment store will take. */
function imageFilesOf(message: SlackMessage): ReadonlyArray<SlackFile> {
  return (message.files ?? [])
    .filter(
      (file) =>
        (file.mimetype ?? "").toLowerCase().startsWith("image/") &&
        (file.url_private_download ?? file.url_private ?? "").length > 0,
    )
    .slice(0, ISSUE_COMMENT_MAX_ATTACHMENTS);
}

export interface SlackIntakePollerShape {
  /**
   * One pass over every active watch. Never fails: a cycle's job is to leave the status honest,
   * and a loop that died on a bad token would stay dead until the server restarted.
   */
  readonly pollOnce: Effect.Effect<void>;
  /**
   * Fold one tracker event into the outbound side. Exposed so the two-way sync can be tested
   * without a live stream, and so the loop below is three lines.
   */
  readonly handleStreamEvent: (event: IssuesStreamEvent) => Effect.Effect<void>;
  /** The polling loop: a pass, then thirty seconds or a poke, whichever comes first. */
  readonly runPolling: Effect.Effect<void>;
  /** The outbound loop: the tracker's own stream, folded forever. */
  readonly runOutbound: Effect.Effect<void>;
}

/** What the outbound side remembers about an issue, so it can tell a status change from a create. */
interface OutboundIssueState {
  readonly key: string;
  readonly statusId: string;
  readonly channelId: string | null;
  readonly threadTs: string | null;
}

export const make = Effect.gen(function* () {
  const tracker = yield* IssueTrackerService;
  const engine = yield* SlackIntakeEngine;
  const client = yield* SlackApiClient;
  const signal = yield* SlackIntakeSignal;
  const watchRepository = yield* SlackChannelWatchRepository;
  const ledger = yield* SlackIntakeLedgerRepository;
  const eventRepository = yield* IssueEventRepository;
  const secretStore = yield* ServerSecretStore;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /**
   * Who the token belongs to, remembered with the token it was read under.
   *
   * `auth.test` is one call, but it is one call per cycle if it is not kept, and the bot's own
   * user id is needed on every single message to decide the mention trigger.
   */
  const identityCache = yield* Ref.make<{
    readonly token: string;
    readonly identity: SlackIdentity;
  } | null>(null);

  const resolveIdentity = (token: string) =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(identityCache);
      if (cached !== null && cached.token === token) return cached.identity;
      const identity = yield* client.authTest({ token });
      yield* Ref.set(identityCache, { token, identity });
      return identity;
    });

  // ── Inbound ──────────────────────────────────────────────────────────

  /** The display name of whoever wrote a message, or null when Slack will not say. */
  const authorNameOf = (token: string, message: SlackMessage) => {
    if (message.user === undefined || message.user.length === 0) {
      return Effect.succeed(message.username ?? null);
    }
    return client
      .displayName({ token, userId: message.user })
      .pipe(Effect.orElseSucceed<string | null>(() => null));
  };

  /**
   * Slack's text as Markdown, with the mentions in it resolved to names.
   *
   * The names are looked up before the conversion because the conversion is pure — it is a string
   * function with tests, and one that made network calls would be neither.
   */
  const renderMessageBody = (token: string, message: SlackMessage) =>
    Effect.gen(function* () {
      const text = message.text ?? "";
      const mentioned = new Set(
        [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((match) => match[1] ?? ""),
      );
      const userNames = new Map<string, string>();
      for (const userId of mentioned) {
        if (userId.length === 0) continue;
        const name = yield* client
          .displayName({ token, userId })
          .pipe(Effect.orElseSucceed<string | null>(() => null));
        if (name !== null) userNames.set(userId, name);
      }
      return slackMrkdwnToMarkdown(text, { userNames });
    });

  /**
   * Slack's images, in the tracker's attachment store, under this issue's own namespace.
   *
   * Through `uploadCommentAttachment` rather than straight to disk: that method already owns the
   * images-only rule, the size ceiling, and the id namespacing that keeps thread cleanup from
   * sweeping an issue's files. A download that fails is skipped rather than raised — an
   * unreachable image must not cost the message it came with.
   */
  const storeImages = (input: {
    readonly token: string;
    readonly issueId: IssueId;
    readonly files: ReadonlyArray<SlackFile>;
  }) =>
    Effect.gen(function* () {
      const attachmentIds: Array<string> = [];
      for (const file of input.files) {
        const url = file.url_private_download ?? file.url_private ?? "";
        if (url.length === 0) continue;
        const image = yield* client
          .downloadImage({
            token: input.token,
            url,
            ...(file.mimetype === undefined ? {} : { declaredMimeType: file.mimetype }),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("slack.intake.image-download-failed", { cause }).pipe(
                Effect.as(null),
              ),
            ),
          );
        if (image === null) continue;
        const dataUrl = `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
        const stored = yield* tracker
          .uploadCommentAttachment({ issueId: input.issueId, dataUrl })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("slack.intake.image-store-failed", { cause }).pipe(Effect.as(null)),
            ),
          );
        if (stored !== null) attachmentIds.push(stored.attachmentId);
      }
      return attachmentIds;
    });

  const describeImageComment = (count: number): string =>
    count === 1 ? "attached an image in Slack." : `attached ${count} images in Slack.`;

  /**
   * Attach a source message's images to the issue it became.
   *
   * As a comment, not as part of the description: an attachment is an id on a comment row in this
   * tracker, and the description is Markdown with nowhere to hang one. The synthetic ledger key
   * is what keeps the comment from being filed twice — Slack will never mint a ts with a `#` in
   * it, so `<ts>#files` can only ever mean this.
   */
  const attachSourceImages = (input: {
    readonly token: string;
    readonly channelId: string;
    readonly messageTs: string;
    readonly issueId: IssueId;
    readonly authorName: string | null;
    readonly files: ReadonlyArray<SlackFile>;
  }) =>
    Effect.gen(function* () {
      const attachmentIds = yield* storeImages({
        token: input.token,
        issueId: input.issueId,
        files: input.files,
      });
      if (attachmentIds.length === 0) return;
      yield* tracker.intakeAddComment({
        channelId: input.channelId,
        threadTs: input.messageTs,
        messageTs: `${input.messageTs}#files`,
        authorName: input.authorName,
        body: describeImageComment(attachmentIds.length),
        attachmentIds,
      });
    });

  /**
   * The one message the bot sends unprompted, and the only place an issue key crosses back over.
   *
   * There is no public URL for this server — the tracker is whatever environment you are
   * connected to — so the link is the in-app route rather than an href that would 404 for
   * everyone who clicked it.
   */
  const confirmFiled = (input: {
    readonly token: string;
    readonly channelId: string;
    readonly messageTs: string;
    readonly issue: Issue;
  }) =>
    Effect.gen(function* () {
      const text = [
        `Filed *${input.issue.key}*: ${truncateForSlack(markdownToSlackMrkdwn(input.issue.title), 160)}`,
        `Open in Pathway: /issues?issue=${input.issue.key}`,
      ].join("\n");
      const posted = yield* client.postToThread({
        token: input.token,
        channelId: input.channelId,
        threadTs: input.messageTs,
        text,
      });
      // Recorded after the post rather than before it: a ts that does not exist yet is not a
      // message the poller could read back, and a post that failed must not leave a ghost in the
      // registry. The bot-authored skip covers the window in between.
      yield* tracker.slackRecordOutboundPost({
        channelId: input.channelId,
        messageTs: posted.messageTs,
      });
    });

  const attachReply = (input: {
    readonly token: string;
    readonly channelId: string;
    readonly threadTs: string;
    readonly message: SlackMessage;
  }) =>
    Effect.gen(function* () {
      const [authorName, body] = yield* Effect.all([
        authorNameOf(input.token, input.message),
        renderMessageBody(input.token, input.message),
      ]);
      const images = imageFilesOf(input.message);
      // The comment has to exist before an attachment can be namespaced to its issue, so the
      // images ride on a second comment the same way a source message's do.
      const result = yield* tracker.intakeAddComment({
        channelId: input.channelId,
        threadTs: input.threadTs,
        messageTs: input.message.ts,
        authorName,
        body: body.trim().length === 0 && images.length > 0 ? "shared an image in Slack." : body,
      });
      if (result.comment === null || images.length === 0) return;
      yield* attachSourceImages({
        token: input.token,
        channelId: input.channelId,
        messageTs: input.message.ts,
        issueId: result.comment.issueId,
        authorName,
        files: images,
      });
    });

  /**
   * Replies that arrived before their parent became an issue.
   *
   * A reply is only attached when the ledger already knows what its parent became, so the replies
   * to a message somebody reacts to a day later would otherwise be lost. Filing the parent is
   * what triggers this catch-up over the thread.
   */
  const catchUpThreadReplies = (input: {
    readonly token: string;
    readonly channelId: string;
    readonly threadTs: string;
    readonly identity: SlackIdentity;
  }) =>
    Effect.gen(function* () {
      const replies = yield* client.replies({
        token: input.token,
        channelId: input.channelId,
        threadTs: input.threadTs,
      });
      for (const reply of replies) {
        if (reply.ts === input.threadTs) continue;
        if (isBotMessage(reply, input.identity) || !isReadableMessage(reply)) continue;
        if (yield* ledger.hasOutbound({ channelId: input.channelId, messageTs: reply.ts })) {
          continue;
        }
        yield* attachReply({
          token: input.token,
          channelId: input.channelId,
          threadTs: input.threadTs,
          message: reply,
        });
      }
    });

  const fileMessage = (input: {
    readonly token: string;
    readonly identity: SlackIdentity;
    readonly watch: SlackChannelWatch;
    readonly message: SlackMessage;
  }) =>
    Effect.gen(function* () {
      const [authorName, description] = yield* Effect.all([
        authorNameOf(input.token, input.message),
        renderMessageBody(input.token, input.message),
      ]);
      const permalink = yield* client
        .permalink({
          token: input.token,
          channelId: input.watch.channelId,
          messageTs: input.message.ts,
        })
        .pipe(Effect.orElseSucceed<string | null>(() => null));

      const { issue, created } = yield* tracker.intakeCreateIssue({
        channelId: input.watch.channelId,
        messageTs: input.message.ts,
        title: slackTitleFromText(description),
        description,
        projectId: input.watch.projectId,
        permalink,
        authorName,
      });
      // Already filed by an overlapping window or an earlier reaction pass. Everything below has
      // happened once already, and doing it again would post a second confirmation.
      if (!created) return;

      const images = imageFilesOf(input.message);
      if (images.length > 0) {
        yield* attachSourceImages({
          token: input.token,
          channelId: input.watch.channelId,
          messageTs: input.message.ts,
          issueId: issue.id,
          authorName,
          files: images,
        });
      }

      if ((input.message.reply_count ?? 0) > 0) {
        yield* catchUpThreadReplies({
          token: input.token,
          channelId: input.watch.channelId,
          threadTs: input.message.ts,
          identity: input.identity,
        });
      }

      yield* confirmFiled({
        token: input.token,
        channelId: input.watch.channelId,
        messageTs: input.message.ts,
        issue,
      });
    });

  /** Whether this message has already been decided about, and became something. */
  const alreadyFiled = (channelId: string, messageTs: string) =>
    ledger
      .getProcessed({ channelId, messageTs })
      .pipe(Effect.map((row) => Option.isSome(row) && row.value.issueId !== null));

  const handleNewMessage = (input: {
    readonly token: string;
    readonly identity: SlackIdentity;
    readonly watch: SlackChannelWatch;
    readonly message: SlackMessage;
  }) =>
    Effect.gen(function* () {
      const { message, watch } = input;
      if (!isReadableMessage(message)) return;
      if (isBotMessage(message, input.identity)) return;
      // The registry the bot's own posts are in. Skipping here is what keeps a status update
      // posted into a watched channel from coming back as a new issue.
      if (yield* ledger.hasOutbound({ channelId: watch.channelId, messageTs: message.ts })) return;

      if (isThreadReply(message)) {
        const threadTs = message.thread_ts ?? message.ts;
        const parent = yield* ledger.getProcessed({
          channelId: watch.channelId,
          messageTs: threadTs,
        });
        // A reply on a thread that is not an issue is left entirely alone — not even marked as
        // seen — so that filing the parent later can still collect it.
        if (Option.isNone(parent) || parent.value.issueId === null) return;
        yield* attachReply({
          token: input.token,
          channelId: watch.channelId,
          threadTs,
          message,
        });
        return;
      }

      if (messageMatchesTrigger(watch.trigger, message, input.identity)) {
        yield* fileMessage(input);
        return;
      }

      // Remembered as read, not as filed. `intakeCreateIssue` ignores a row with no issue on it,
      // so a reaction added tomorrow can still turn this into one.
      yield* ledger.recordProcessed({
        channelId: watch.channelId,
        messageTs: message.ts,
        issueId: null,
        createdAt: yield* nowIso,
      });
    });

  /**
   * The second pass: recent history re-read for the trigger emoji.
   *
   * Bounded twice, because both bounds are real. Seven days is how long a reaction can be
   * noticed; a hundred messages is what stops a firehose channel from being re-walked forever,
   * and when that bound bites the floor moves up to the oldest message actually looked at.
   */
  const scanReactions = (input: {
    readonly token: string;
    readonly identity: SlackIdentity;
    readonly watch: SlackChannelWatch;
    readonly floor: string;
  }) =>
    Effect.gen(function* () {
      const emoji = input.watch.trigger.emoji;
      if (emoji === null) return input.floor;

      const page = yield* client.history({
        token: input.token,
        channelId: input.watch.channelId,
        oldest: input.floor,
        limit: SLACK_REACTION_WINDOW_MESSAGES,
      });
      const ordered = [...page.messages].sort((left, right) => compareSlackTs(left.ts, right.ts));

      for (const message of ordered) {
        if (!isReadableMessage(message) || isThreadReply(message)) continue;
        if (isBotMessage(message, input.identity)) continue;
        if (!messageHasReaction(message, emoji)) continue;
        if (yield* alreadyFiled(input.watch.channelId, message.ts)) continue;
        yield* fileMessage({
          token: input.token,
          identity: input.identity,
          watch: input.watch,
          message,
        });
      }

      const oldest = ordered[0]?.ts ?? null;
      return page.hasMore && oldest !== null
        ? (laterTs(input.floor, oldest) ?? input.floor)
        : input.floor;
    });

  const pollChannel = (input: {
    readonly token: string;
    readonly identity: SlackIdentity;
    readonly watch: SlackChannelWatch;
  }) =>
    Effect.gen(function* () {
      const { watch } = input;
      const cursor = yield* ledger.getCursor({ channelId: watch.channelId });
      const lastTs = Option.isSome(cursor) ? cursor.value.lastTs : null;
      const nowTs = slackTsFromMillis(yield* Clock.currentTimeMillis);

      // Every page since the cursor, not merely the newest one. A laptop that was shut for a week
      // wakes up behind, and catching up is the only reason this is a cursor rather than a socket.
      const collected: Array<SlackMessage> = [];
      let pageCursor: string | null = null;
      for (let page = 0; page < SLACK_MAX_HISTORY_PAGES; page += 1) {
        const answer: SlackHistoryPage = yield* client.history({
          token: input.token,
          channelId: watch.channelId,
          oldest: lastTs,
          cursor: pageCursor,
        });
        collected.push(...answer.messages);
        pageCursor = answer.hasMore ? answer.nextCursor : null;
        if (pageCursor === null) break;
      }

      const ordered = collected.sort((left, right) => compareSlackTs(left.ts, right.ts));
      const newestTs = ordered.reduce<string | null>(
        (newest, message) => laterTs(newest, message.ts),
        lastTs,
      );

      if (lastTs === null) {
        // First sight of this channel. The cursor is planted and nothing is filed: watching a
        // channel means "from now on", not "and everything that was ever said in it".
        const planted = newestTs ?? nowTs;
        yield* ledger.setCursor({
          channelId: watch.channelId,
          lastTs: planted,
          reactionScanTs: planted,
          updatedAt: yield* nowIso,
        });
        return;
      }

      for (const message of ordered) {
        yield* handleNewMessage({
          token: input.token,
          identity: input.identity,
          watch,
          message,
        });
      }

      const previousScanTs = Option.isSome(cursor) ? cursor.value.reactionScanTs : null;
      const windowFloor =
        laterTs(
          previousScanTs,
          slackTsFromMillis(
            (yield* Clock.currentTimeMillis) - SLACK_REACTION_WINDOW_SECONDS * 1000,
          ),
        ) ?? nowTs;
      const reactionScanTs =
        watch.trigger.emoji === null
          ? previousScanTs
          : yield* scanReactions({
              token: input.token,
              identity: input.identity,
              watch,
              floor: windowFloor,
            });

      yield* ledger.setCursor({
        channelId: watch.channelId,
        lastTs: newestTs,
        reactionScanTs,
        updatedAt: yield* nowIso,
      });
    });

  const recordPoll = (error: string | null) =>
    tracker.slackRecordPoll({ error }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("slack.intake.status-unwritable", { cause })),
      Effect.asVoid,
    );

  const pollOnce: SlackIntakePollerShape["pollOnce"] = Effect.gen(function* () {
    const token = yield* readSlackBotToken(secretStore);
    if (Option.isNone(token)) return;

    const watches = yield* watchRepository
      .listAll()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("slack.intake.watches-unreadable", { cause }).pipe(
            Effect.as<ReadonlyArray<SlackChannelWatch>>([]),
          ),
        ),
      );
    const active = watches.filter((watch) => isSlackIntakeTriggerActive(watch.trigger));
    if (active.length === 0) return;

    const identity = yield* Effect.result(resolveIdentity(token.value));
    if (Result.isFailure(identity)) {
      // A token Slack will not accept is the whole integration's problem, not one channel's.
      yield* recordPoll(identity.failure.message);
      return;
    }

    let firstError: string | null = null;
    const noteFailure = (watch: SlackChannelWatch, detail: string) =>
      Effect.sync(() => {
        firstError ??= `#${watch.channelName}: ${detail}`;
      });

    for (const watch of active) {
      yield* pollChannel({ token: token.value, identity: identity.success, watch }).pipe(
        Effect.catch((error) =>
          noteFailure(watch, errorSentence(error)).pipe(
            Effect.andThen(
              Effect.logWarning("slack.intake.channel-failed", {
                channelId: watch.channelId,
                error,
              }),
            ),
          ),
        ),
        Effect.catchDefect((defect) =>
          noteFailure(watch, "the channel could not be read").pipe(
            Effect.andThen(
              Effect.logWarning("slack.intake.channel-defect", {
                channelId: watch.channelId,
                defect,
              }),
            ),
          ),
        ),
      );
    }

    yield* recordPoll(firstError);
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("slack.intake.poll-failed", { cause })),
    Effect.withSpan("SlackIntakePoller.pollOnce"),
  );

  // ── Outbound ─────────────────────────────────────────────────────────

  const issueStates = yield* Ref.make(new Map<IssueId, OutboundIssueState>());

  const post = (input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly text: string;
  }) =>
    engine
      .postIssueUpdate({
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: truncateForSlack(input.text),
      })
      .pipe(
        Effect.flatMap((posted) =>
          tracker.slackRecordOutboundPost({
            channelId: input.channelId,
            messageTs: posted.messageTs,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("slack.outbound.post-failed", { channelId: input.channelId, cause }),
        ),
        Effect.asVoid,
      );

  /**
   * Who moved the status, and what they moved it to.
   *
   * From the change log rather than from the stream: `IssueUpserted` carries the issue, not the
   * hand that moved it, and the log already stores the status names either side of the change —
   * which is the sentence, without a second read of the status table.
   */
  const lastStatusChange = (issueId: IssueId) =>
    eventRepository.listByIssue({ issueId }).pipe(
      Effect.map((events) =>
        events.findLast((event) => event.kind === "field_changed" && event.field === "status"),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("slack.outbound.events-unreadable", { cause }).pipe(Effect.as(undefined)),
      ),
    );

  const handleIssueUpserted = (issue: Issue) =>
    Effect.gen(function* () {
      const previous = (yield* Ref.get(issueStates)).get(issue.id);
      const next: OutboundIssueState = {
        key: issue.key,
        statusId: issue.statusId,
        channelId: issue.slackSource?.channelId ?? null,
        threadTs: issue.slackSource?.messageTs ?? null,
      };
      yield* Ref.update(issueStates, (current) => new Map(current).set(issue.id, next));

      // A first sighting is the opening replay or a brand new issue. Neither is a status change,
      // and the replay would otherwise post the entire tracker into Slack on every restart.
      if (previous === undefined || previous.statusId === issue.statusId) return;
      if (next.channelId === null || next.threadTs === null) return;
      if (issue.deletedAt !== null) return;

      const event = yield* lastStatusChange(issue.id);
      if (event === undefined || event.after === null) return;
      // The one write intake makes itself. Posting it would be the bot narrating its own reading.
      if (event.actor.kind === "system" && event.actor.source === "slack") return;

      yield* post({
        channelId: next.channelId,
        threadTs: next.threadTs,
        text: `${slackActorLabel(event.actor)} moved ${issue.key} to ${event.after}`,
      });
    });

  const handleCommentUpserted = (comment: {
    readonly issueId: IssueId;
    readonly author: IssueActor;
    readonly body: string;
    readonly editedAt: string | null;
  }) =>
    Effect.gen(function* () {
      // An edit republishes the comment. Posting it again would read as the person saying it
      // twice, and Slack has no notion of editing somebody else's message.
      if (comment.editedAt !== null) return;
      // Every system write, which is every comment intake wrote on the way in. This is the other
      // half of echo suppression: the ledger stops messages looping, this stops comments looping.
      if (comment.author.kind === "system") return;

      const state = (yield* Ref.get(issueStates)).get(comment.issueId);
      if (state === undefined || state.channelId === null || state.threadTs === null) return;

      yield* post({
        channelId: state.channelId,
        threadTs: state.threadTs,
        text: `${slackActorLabel(comment.author)}: ${markdownToSlackMrkdwn(comment.body)}`,
      });
    });

  const handleStreamEvent: SlackIntakePollerShape["handleStreamEvent"] = (event) => {
    switch (event._tag) {
      case "IssueUpserted":
        return handleIssueUpserted(event.issue);
      case "IssueCommentUpserted":
        return handleCommentUpserted(event.comment);
      default:
        return Effect.void;
    }
  };

  const runOutbound: SlackIntakePollerShape["runOutbound"] = Stream.runForEach(
    tracker.stream,
    handleStreamEvent,
  ).pipe(
    Effect.catchCause((cause) => Effect.logWarning("slack.outbound.stream-ended", { cause })),
    Effect.asVoid,
  );

  const runPolling: SlackIntakePollerShape["runPolling"] = Effect.forever(
    pollOnce.pipe(
      // A poke from a settings write shortens the wait to nothing; otherwise the interval. The
      // race is the whole reason a watch created now starts reading now.
      Effect.andThen(
        Effect.raceFirst(
          Effect.sleep(Duration.millis(SLACK_POLL_INTERVAL_MS)),
          signal.awaitNotification,
        ),
      ),
    ),
  );

  return { pollOnce, handleStreamEvent, runPolling, runOutbound } satisfies SlackIntakePollerShape;
});

/**
 * The sentence off a failure, whatever kind it is.
 *
 * Everything a channel pass can fail with — a Slack refusal, a tracker error, a repository error
 * — already writes a human `message`. This only has to find it.
 */
function errorSentence(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * Both loops, forked at the activation boundary the rest of the server's background work uses.
 *
 * Provides nothing: this layer exists for its effect, and nothing depends on the poller — which
 * is precisely what lets the poller depend on both the tracker and the engine.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const poller = yield* make;
    yield* forkParked(poller.runOutbound);
    yield* forkParked(poller.runPolling);
    yield* Effect.logDebug("slack.intake.started", { intervalMs: SLACK_POLL_INTERVAL_MS });
  }),
);
