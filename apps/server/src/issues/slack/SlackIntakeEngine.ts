/**
 * SlackIntakeEngine - the seam between intake's *records* and intake's *transport*.
 *
 * `IssueTrackerService` owns everything that is a row: the watched channels, the triage issues a
 * poll produces, the comments a thread reply becomes, the ledger of what has been read and what
 * the bot wrote. This service owns the only part that is a network call — talking to Slack.
 *
 * The split is the same one enrichment made (`IssueEnrichmentEngine.ts`), and for the same reason:
 * an engine that reached for `IssueTrackerService` would make the two layers require one another
 * and neither would build. Intake goes the other way round instead — the engine calls the
 * tracker's `intakeCreateIssue` and `intakeAddComment` with what it read, and the tracker pokes the
 * engine through {@link SlackIntakeEngineShape.notifyWatchesChanged} when the configuration moves.
 *
 * @module issues/slack/SlackIntakeEngine
 */
import { IssueTrackerError } from "@spiritdevs/contracts";
import type { SlackChannelId, SlackChannelRef, SlackMessageTs } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface SlackPostIssueUpdateInput {
  readonly channelId: SlackChannelId;
  /**
   * The source message's ts. Every outbound post is a reply in the thread the issue came from —
   * never a new top-level message, which would read as the bot starting a conversation nobody had.
   */
  readonly threadTs: SlackMessageTs;
  /**
   * Already attributed by the caller: "Corey: …", "Claude moved PAT-12 to In Review". The engine
   * posts the string it is given, so who said what is the tracker's sentence to write.
   */
  readonly text: string;
}

export interface SlackIntakeEngineShape {
  /**
   * Try a token against Slack and answer with the workspace it belongs to.
   *
   * Called with the *candidate* token, before anything is written: a token that does not work is
   * refused rather than stored, so "configured" never means "configured with something broken".
   */
  readonly testConnection: (input: {
    readonly token: string;
  }) => Effect.Effect<{ readonly workspaceName: string }, IssueTrackerError>;

  /**
   * Every channel the bot can see, for the picker. Asked of Slack on each call rather than
   * cached: a channel the bot was invited to a minute ago has to show up.
   */
  readonly listChannels: Effect.Effect<ReadonlyArray<SlackChannelRef>, IssueTrackerError>;

  /**
   * Tell the poller its configuration moved.
   *
   * Fire-and-forget by design — it cannot fail, and a watch write must not be rolled back because
   * the poller was mid-sleep. The next pass reads the new set either way; this only shortens the
   * wait from one interval to none.
   */
  readonly notifyWatchesChanged: Effect.Effect<void>;

  /**
   * Post one update into a source thread, and answer with the ts Slack gave it.
   *
   * The caller records that ts in the outbound registry before the next poll can read the message
   * back. That registry is the entire echo-suppression story, so an answer without a ts is worse
   * than a failure: it would leave a post nothing recognises as the bot's own.
   */
  readonly postIssueUpdate: (
    input: SlackPostIssueUpdateInput,
  ) => Effect.Effect<{ readonly messageTs: SlackMessageTs }, IssueTrackerError>;
}

export class SlackIntakeEngine extends Context.Service<SlackIntakeEngine, SlackIntakeEngineShape>()(
  "@spiritdevs/pathway/issues/slack/SlackIntakeEngine",
) {}

/** Every refusal this stub gives, so the message is one string rather than three. */
const UNAVAILABLE = "Slack intake is not available on this server.";

const unavailable = Effect.fail(new IssueTrackerError({ reason: "invalid", message: UNAVAILABLE }));

/**
 * Intake before there is a transport.
 *
 * `testConnection` refusing is what matters: a token can never be stored on a server with no way
 * to use it, so the settings page says "not available" instead of reporting a connection that
 * will never poll. Watch rows are still writable — they are configuration, and configuring a
 * channel before the transport exists costs nothing.
 */
export const layerStub = Layer.succeed(SlackIntakeEngine, {
  testConnection: () => unavailable,
  listChannels: unavailable,
  notifyWatchesChanged: Effect.void,
  postIssueUpdate: () => unavailable,
} satisfies SlackIntakeEngineShape);
