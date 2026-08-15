/**
 * Turns issue keys said in conversation into durable relations. A completed chat message that
 * names a real issue links its thread to that issue, so the issue's Threads list and the thread's
 * Issues section agree without anybody pressing a button.
 *
 * Nothing here decides what a mention *looks like* — {@link extractIssueKeyMentions} produces
 * candidates and the issue table is the filter, because a regex loose enough to catch every key is
 * also loose enough to catch "UTF-8". A candidate that resolves to a live issue becomes a
 * `mention` link, the weakest origin, so it can never demote a thread that was started from the
 * issue or attached by hand.
 *
 * Everything on the per-message path is a read the message earned: candidates first, then one
 * indexed key lookup each, then — only for a thread that actually named a live issue — one cached
 * lineage read to keep a delegated subagent's child thread off the issue's Threads list.
 */
import {
  extractIssueKeyMentions,
  type IssueActor,
  type IssueId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { IssueRepository } from "../persistence/Services/Issues.ts";
import { IssueTrackerService } from "./IssueTrackerService.ts";

/** The `projection_state` key holding how far this reactor has read the V2 event log. */
export const ISSUE_MENTION_PROJECTOR = "issue-mention-links";

/**
 * A mention has no author the tracker can name: it is the reactor noticing a key, not a person
 * or an agent claiming a thread. `system` is what the feed already says for work nobody asked for,
 * and a mention writes no change-log row anyway.
 */
const MENTION_ACTOR: IssueActor = { kind: "system", source: "automation" };

/**
 * How far the cursor may drift before it is written anyway. The cursor only bounds the replay and
 * relinking is idempotent, so an upsert per orchestration event would tax a streaming turn for
 * nothing — but a server that is busy without anyone naming an issue still has to boot without
 * rescanning its whole history.
 */
const CURSOR_STRIDE = 500;

const withLoggedFailure = <E, R>(label: string, effect: Effect.Effect<void, E, R>) =>
  effect.pipe(Effect.catchCause((cause) => Effect.logWarning(label, { cause })));

type MessageUpdatedEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "message.updated" }
>;

/**
 * The messages worth scanning: settled ones only, because a streaming draft says the same key a
 * dozen times on its way to saying it once, and never the system preamble, which is scaffolding
 * rather than something a user or an agent said.
 */
export function isIssueMentionCandidate(
  event: OrchestrationV2DomainEvent,
): event is MessageUpdatedEvent {
  return (
    event.type === "message.updated" &&
    event.payload.streaming === false &&
    event.payload.role !== "system"
  );
}

/**
 * What one message needs to become links: somewhere to resolve a key, somewhere to write, and a
 * way to tell a thread a person can open from a delegated subagent's child thread.
 */
export interface IssueMentionContext {
  readonly tracker: IssueTrackerService["Service"];
  readonly issues: IssueRepository["Service"];
  readonly isRootThread: (threadId: ThreadId) => Effect.Effect<boolean, OrchestratorV2Error>;
}

/**
 * Link one message's resolvable issue keys to its thread. Safe to run on the same event twice:
 * `linkThread` keys on the pair and never weakens an origin it already holds, which is what lets
 * the replay overlap the live tail without inventing a dedupe table.
 */
export const linkIssueKeyMentions = Effect.fn("IssueMentionLinker.linkIssueKeyMentions")(function* (
  message: OrchestrationV2ConversationMessage,
  context: IssueMentionContext,
) {
  const keys = extractIssueKeyMentions(message.text);
  if (keys.length === 0) return;

  // One indexed read per distinct candidate, never the tracker's snapshot: the candidate pattern
  // is loose by design and "UTF-8", "SHA-256" and "GPT-4" are everywhere in agent prose, so this
  // runs constantly. `getSnapshot` finalises ended cycles — a write — and then reads eight
  // tables; noticing a key in passing must never be either of those things.
  const mentioned: Array<IssueId> = [];
  for (const key of keys) {
    // The candidate pattern is the key pattern, so every candidate is a well-formed key here;
    // resolving it is what separates "ISS-31" from "UTF-8". A soft-deleted issue stays deleted:
    // a mention must not resurrect it in anybody's Threads list.
    const found = yield* context.issues.getByKey({ key });
    const record = Option.getOrNull(found);
    if (record !== null && record.deletedAt === null) mentioned.push(record.id);
  }
  if (mentioned.length === 0) return;

  // Only now, and at most once per thread that ever names a live key: a delegated subagent's
  // prompt routinely quotes the issue key its parent was given, and its child thread is not on
  // any list a person can open — linking it fills the issue's Threads list with dead ids. The
  // shell read is off the per-message path because unresolved keys have already returned above,
  // and lineage never changes, so the answer is cached for the rest of the process.
  if (!(yield* context.isRootThread(message.threadId))) return;

  yield* Effect.forEach(
    mentioned,
    (issueId) =>
      context.tracker.linkThread(
        { issueId, threadId: message.threadId, origin: "mention" },
        MENTION_ACTOR,
      ),
    { concurrency: 1, discard: true },
  );
});

/**
 * The reactor as one effect, so a test can drive it to completion over a finite stream instead of
 * racing a forked fiber.
 */
export const run = Effect.gen(function* () {
  const tracker = yield* IssueTrackerService;
  const issues = yield* IssueRepository;
  const threads = yield* ThreadManagementService;
  const projectionState = yield* ProjectionStateRepository;

  // A thread's lineage is fixed when it is created, so one shell read answers for the life of the
  // process. Deriving this from `thread.created` events instead would be free, but a restart tails
  // from a cursor that is past those events and would forget every existing subagent thread.
  const rootThreads = yield* Ref.make(new Map<ThreadId, boolean>());
  const isRootThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const cached = (yield* Ref.get(rootThreads)).get(threadId);
      if (cached !== undefined) return cached;
      const shell = yield* threads.getThreadShell(threadId);
      // A thread the shell projection does not have is one nobody can open either, so it is
      // treated the same as a subagent's: no relation is created for it.
      const root = shell !== null && shell.lineage.relationshipToParent !== "subagent";
      yield* Ref.update(rootThreads, (current) => new Map(current).set(threadId, root));
      return root;
    });
  const context: IssueMentionContext = { tracker, issues, isRootThread };

  const start = yield* projectionState
    .getByProjector({ projector: ISSUE_MENTION_PROJECTOR })
    .pipe(
      Effect.map(Option.match({ onNone: () => 0, onSome: (state) => state.lastAppliedSequence })),
    );
  const written = yield* Ref.make(start);

  const advance = (sequence: number, scanned: boolean) =>
    Effect.flatMap(Ref.get(written), (last) =>
      scanned || sequence - last >= CURSOR_STRIDE
        ? DateTime.now.pipe(
            Effect.flatMap((now) =>
              projectionState.upsert({
                projector: ISSUE_MENTION_PROJECTOR,
                lastAppliedSequence: sequence,
                updatedAt: DateTime.formatIso(now),
              }),
            ),
            Effect.andThen(Ref.set(written, sequence)),
          )
        : Effect.void,
    );

  // One stream is catch-up and live tail both: `streamStoredEventsFrom` replays everything after
  // the cursor and then keeps going, so there is no handoff to drop an event through or replay a
  // window twice. `streamDomainEvents` is the wrong tool here — it seeks to the end of the log
  // when it is built, which loses every message committed while the server was down. An absent
  // cursor means this install has never run the reactor; the replay from genesis it gets happens
  // once, and it is how existing conversations pick up their links.
  yield* Stream.runForEach(threads.streamStoredEventsFrom({ afterSequence: start }), (stored) => {
    if (!isIssueMentionCandidate(stored.event)) return advance(stored.sequence, false);
    // The cursor moves even when a message failed: one unlinkable message must not wedge every
    // later one behind it, and there is nothing to retry that a later mention would not redo.
    return withLoggedFailure(
      "issue.mention.message-failed",
      linkIssueKeyMentions(stored.event.payload, context),
    ).pipe(Effect.andThen(advance(stored.sequence, true)));
  });
});

// Forked off the boot path: the replay is bounded but an install that has never run this walks its
// whole log, and nothing about serving a client waits on that finishing.
export const make = Effect.forkScoped(withLoggedFailure("issue.mention.stream-failed", run));

export const layer = Layer.effectDiscard(make);
