import type {
  ApplicationStoredEvent,
  OrchestrationProjectShell,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
} from "@spiritdevs/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ApplicationAggregateChange } from "../persistence/Services/OrchestrationEventStore.ts";

type ShellItem = OrchestrationV2ShellStreamItem;
type RepositoryIdentityEntry = Extract<
  OrchestrationV2ShellStreamItem,
  { readonly kind: "repositoryIdentities" }
>["identities"][number];

/** The shell-relevant part of one committed application event. */
export function aggregateChangeFromApplicationEvent(
  stored: ApplicationStoredEvent,
): ApplicationAggregateChange {
  if ("aggregateKind" in stored) {
    return {
      aggregateKind: "project",
      projectId: stored.aggregateId,
      sequence: stored.sequence,
      deleted: stored.type === "project.deleted",
    };
  }
  return {
    aggregateKind: "thread",
    threadId: stored.event.threadId,
    sequence: stored.sequence,
    deletedFromArchive:
      stored.event.type === "thread.deleted" && stored.event.payload.archivedAt !== null,
  };
}

/** Keep only the newest change per project/thread aggregate. */
export function coalesceAggregateChanges(
  changes: ReadonlyArray<ApplicationAggregateChange>,
): ReadonlyArray<ApplicationAggregateChange> {
  const latestByAggregate = new Map<string, ApplicationAggregateChange>();
  for (const change of changes) {
    const key =
      change.aggregateKind === "project"
        ? `project:${change.projectId}`
        : `thread:${change.threadId}`;
    latestByAggregate.set(key, change);
  }
  return Array.from(latestByAggregate.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

/**
 * Emit the initial shell prefix strictly first, then merge the post-prefix
 * tail with enrichment refreshes. Prevents a newer marked enrichment from
 * landing before the unmarked authoritative initial snapshot.
 */
export function composeShellStreamWithEnrichment<A, E, R, A2, E2, R2, A3, E3, R3>(input: {
  readonly initial: Stream.Stream<A, E, R>;
  readonly tail: Stream.Stream<A2, E2, R2>;
  readonly enrichment: Stream.Stream<A3, E3, R3>;
}): Stream.Stream<A | A2 | A3, E | E2 | E3, R | R2 | R3> {
  return Stream.concat(input.initial, Stream.merge(input.tail, input.enrichment));
}

/** Build a shell snapshot stream item for a batched enrichment completion. */
export function shellStreamItemFromEnrichmentRefresh(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly changes: ReadonlyArray<{ readonly workspaceRoot: string }>;
}): Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  return {
    kind: "snapshot",
    snapshot: input.snapshot,
    resolvedRepositoryIdentityRoots: [
      ...new Set(input.changes.map((change) => change.workspaceRoot)),
    ],
  };
}

/**
 * Initial subscribe frames: the unmarked authoritative snapshot, then a
 * same-sequence enrichment frame only when some roots already resolved.
 *
 * A `resume` (the client passed a cursor at or below this snapshot) sends the
 * marked frame alone. Clients merge a marked snapshot newer than their cache as
 * a replacement and one at their cache's sequence as an identity patch, which is
 * what the unmarked-then-marked pair produced; clients that predate the marker
 * treat it as authoritative. That saves one full shell snapshot per resume.
 */
export function shellStreamItemsFromInitialSnapshot(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
  readonly resume?: boolean;
}): ReadonlyArray<Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>> {
  const authoritative = {
    kind: "snapshot" as const,
    snapshot: input.snapshot,
  };
  if (input.resolvedRepositoryIdentityRoots.length === 0) {
    return [authoritative];
  }
  const marked = {
    kind: "snapshot" as const,
    snapshot: input.snapshot,
    resolvedRepositoryIdentityRoots: [...new Set(input.resolvedRepositoryIdentityRoots)],
  };
  return input.resume === true ? [marked] : [authoritative, marked];
}

/** One patch entry per workspace root among `projects` whose identity resolved. */
export function resolvedRepositoryIdentities(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}): ReadonlyArray<RepositoryIdentityEntry> {
  const resolved = new Set(input.resolvedRepositoryIdentityRoots);
  const byRoot = new Map<string, RepositoryIdentityEntry>();
  for (const project of input.projects) {
    if (project.workspaceRoot !== null && resolved.has(project.workspaceRoot)) {
      byRoot.set(project.workspaceRoot, {
        workspaceRoot: project.workspaceRoot,
        repositoryIdentity: project.repositoryIdentity ?? null,
      });
    }
  }
  return Array.from(byRoot.values());
}

/**
 * Tracks the repository identity one shell subscriber already holds per
 * workspace root. Enrichment re-resolves roots when its cache expires and
 * republishes unchanged values; each of those used to reload and re-send the
 * whole shell snapshot to every subscriber.
 */
export function makeDeliveredRepositoryIdentities() {
  const delivered = new Map<string, string>();
  const identityKey = (identity: unknown) => JSON.stringify(identity ?? null);
  return {
    /** Records identities an initial frame delivered. */
    record: (identities: Iterable<RepositoryIdentityEntry>) => {
      for (const entry of identities) {
        delivered.set(entry.workspaceRoot, identityKey(entry.repositoryIdentity));
      }
    },
    /**
     * Keeps the newest completion per root whose identity differs from what
     * was delivered, and records it as delivered.
     */
    takeUndelivered: <
      Change extends {
        readonly workspaceRoot: string;
        readonly enrichment: { readonly repositoryIdentity: unknown };
      },
    >(
      changes: Iterable<Change>,
    ): ReadonlyArray<Change> => {
      const latestByRoot = new Map<string, Change>();
      for (const change of changes) latestByRoot.set(change.workspaceRoot, change);
      const undelivered: Array<Change> = [];
      for (const [root, change] of latestByRoot) {
        const key = identityKey(change.enrichment.repositoryIdentity);
        if (delivered.get(root) === key) continue;
        delivered.set(root, key);
        undelivered.push(change);
      }
      return undelivered;
    },
  };
}

/**
 * Resolved enrichment completions, batched over 25ms, that change an identity
 * the subscriber holds. `refresh` builds the frame for each batch.
 */
export function enrichmentRefreshes<
  Change extends {
    readonly workspaceRoot: string;
    readonly repositoryIdentityResolved: boolean;
    readonly enrichment: { readonly repositoryIdentity: unknown };
  },
  A,
  E,
  R,
  E2,
  R2,
>(input: {
  readonly changes: Stream.Stream<Change, E, R>;
  readonly delivered: ReturnType<typeof makeDeliveredRepositoryIdentities>;
  readonly refresh: (changes: ReadonlyArray<Change>) => Effect.Effect<A, E2, R2>;
}): Stream.Stream<A, E | E2, R | R2> {
  return input.changes.pipe(
    Stream.filter((change) => change.repositoryIdentityResolved),
    Stream.groupedWithin(64, Duration.millis(25)),
    Stream.map((changes) => input.delivered.takeUndelivered(changes)),
    Stream.filter((changes) => changes.length > 0),
    Stream.mapEffect(input.refresh),
  );
}

/** A shell snapshot with the roots whose repository identity it resolved. */
export interface LoadedShellSnapshot {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}

/**
 * Builds one shell subscription from its cursor.
 *
 * Without a usable cursor (none, ahead of the log, or more than `maxReplayGap`
 * behind) it sends a full snapshot. With one, it replays the changed projects
 * and threads. A client that accepts `repositoryIdentities` frames then gets a
 * project-only identity patch and no full snapshot at all; older clients still
 * get the marked full snapshot first.
 *
 * Enrichment refreshes merge only after the opening frames, so a refresh can
 * never land before the frame that recorded what this subscriber holds.
 */
export const openShellSubscription = Effect.fn("ShellStream.openShellSubscription")(function* <
  E,
  R,
>(input: {
  readonly afterSequence: number | undefined;
  readonly requestCompletionMarker: boolean;
  readonly repositoryIdentityPatches: boolean;
  readonly maxReplayGap: number;
  readonly latestSequence: Effect.Effect<number, E, R>;
  readonly loadSnapshot: Effect.Effect<LoadedShellSnapshot, E, R>;
  /** Projects and the high-water sequence they reflect, read together. */
  readonly loadProjects: Effect.Effect<
    {
      readonly highWater: number;
      readonly projects: ReadonlyArray<OrchestrationProjectShell>;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    },
    E,
    R
  >;
  readonly replay: (range: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }) => Stream.Stream<ShellItem, E, R>;
  readonly live: (afterSequence: number) => Stream.Stream<ShellItem, E, R>;
  readonly enrichment: Stream.Stream<ShellItem, E, R>;
  readonly delivered: ReturnType<typeof makeDeliveredRepositoryIdentities>;
}) {
  const completionMarker: Stream.Stream<ShellItem> = input.requestCompletionMarker
    ? Stream.make({ kind: "synchronized" })
    : Stream.empty;
  const canReplay = (afterSequence: number, highWater: number) =>
    highWater >= afterSequence && highWater - afterSequence <= input.maxReplayGap;
  const identityPatch = (
    identities: ReadonlyArray<RepositoryIdentityEntry>,
  ): Stream.Stream<ShellItem> => {
    input.delivered.record(identities);
    return identities.length === 0
      ? Stream.empty
      : Stream.make({ kind: "repositoryIdentities", identities });
  };
  const fromSnapshot = (loaded: LoadedShellSnapshot, resume: boolean): Stream.Stream<ShellItem> => {
    const identities = resolvedRepositoryIdentities({
      projects: loaded.snapshot.projects,
      resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
    });
    if (input.repositoryIdentityPatches) {
      return Stream.concat(
        Stream.make({ kind: "snapshot", snapshot: loaded.snapshot }),
        identityPatch(identities),
      );
    }
    input.delivered.record(identities);
    return Stream.fromIterable(
      shellStreamItemsFromInitialSnapshot({
        snapshot: loaded.snapshot,
        resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        resume,
      }),
    );
  };
  const fullSnapshot = (loaded: LoadedShellSnapshot) =>
    composeShellStreamWithEnrichment({
      initial: fromSnapshot(loaded, false),
      tail: Stream.concat(completionMarker, input.live(loaded.snapshot.snapshotSequence)),
      enrichment: input.enrichment,
    });

  const afterSequence = input.afterSequence;
  if (afterSequence !== undefined && input.repositoryIdentityPatches) {
    const loaded = yield* input.loadProjects;
    if (canReplay(afterSequence, loaded.highWater)) {
      // The patch follows the replay so projects created inside the gap
      // already exist on the client when their identity arrives.
      return composeShellStreamWithEnrichment({
        initial: Stream.concat(
          input.replay({ afterSequence, throughSequence: loaded.highWater }),
          identityPatch(resolvedRepositoryIdentities(loaded)),
        ),
        tail: Stream.concat(completionMarker, input.live(loaded.highWater)),
        enrichment: input.enrichment,
      });
    }
  }

  const loaded = yield* input.loadSnapshot;
  if (afterSequence === undefined || input.repositoryIdentityPatches) return fullSnapshot(loaded);
  const highWater = yield* input.latestSequence;
  if (!canReplay(afterSequence, highWater)) return fullSnapshot(loaded);
  return composeShellStreamWithEnrichment({
    initial: fromSnapshot(loaded, true),
    tail: Stream.concat(
      Stream.concat(input.replay({ afterSequence, throughSequence: highWater }), completionMarker),
      input.live(highWater),
    ),
    enrichment: input.enrichment,
  });
});

/** Keep only the newest stored event per thread within a coalescing window. */
export function coalesceStoredThreadEvents(
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
): ReadonlyArray<OrchestrationV2StoredEvent> {
  const latestByThreadId = new Map<string, OrchestrationV2StoredEvent>();
  for (const stored of events) {
    latestByThreadId.set(stored.event.threadId, stored);
  }
  return Array.from(latestByThreadId.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

/**
 * Converts a thread's newest change and its current shell into one delta.
 * `shell` is null when the thread is deleted or unknown.
 */
export function shellStreamItemFromThreadShell(input: {
  readonly change: Extract<ApplicationAggregateChange, { readonly aggregateKind: "thread" }>;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Extract<ShellItem, { readonly kind: "thread.updated" | "thread.removed" }> {
  if (input.shell !== null) {
    return {
      kind: "thread.updated",
      sequence: input.change.sequence,
      location: input.shell.archivedAt === null ? "active" : "archive",
      thread: input.shell,
    };
  }

  return {
    kind: "thread.removed",
    sequence: input.change.sequence,
    location: input.change.deletedFromArchive ? "archive" : "active",
    threadId: input.change.threadId,
  };
}

/** Converts a committed event into an archive-only delta when it changes archive membership. */
export function archivedShellStreamItemFromThreadShell(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Exclude<OrchestrationV2ArchivedShellStreamItem, { readonly kind: "snapshot" }> | null {
  if (input.shell !== null && input.shell.archivedAt !== null) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      thread: input.shell,
    };
  }
  if (
    input.stored.event.type === "thread.unarchived" ||
    (input.stored.event.type === "thread.deleted" && input.stored.event.payload.archivedAt !== null)
  ) {
    return {
      kind: "thread.removed",
      sequence: input.stored.sequence,
      threadId: input.stored.event.threadId,
    };
  }
  return null;
}
