import type {
  ApplicationStoredEvent,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
} from "@spiritdevs/contracts";
import * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Keep only the newest shell-relevant event per project/thread aggregate. */
export function coalesceShellApplicationEvents(
  events: ReadonlyArray<ApplicationStoredEvent>,
): ReadonlyArray<ApplicationStoredEvent> {
  const latestByAggregate = new Map<string, ApplicationStoredEvent>();
  for (const stored of events) {
    const key =
      "aggregateKind" in stored
        ? `project:${stored.aggregateId}`
        : `thread:${stored.event.threadId}`;
    latestByAggregate.set(key, stored);
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
    /** Records the identities a marked snapshot frame delivered for `roots`. */
    recordSnapshot: (snapshot: OrchestrationV2ShellSnapshot, roots: ReadonlyArray<string>) => {
      const resolved = new Set(roots);
      for (const project of snapshot.projects) {
        if (project.workspaceRoot !== null && resolved.has(project.workspaceRoot)) {
          delivered.set(project.workspaceRoot, identityKey(project.repositoryIdentity));
        }
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
 * Converts a committed event and the affected thread's current shell into one
 * delta. `shell` is null when the thread is deleted or unknown.
 */
export function shellStreamItemFromThreadShell(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  if (input.shell !== null) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      location: input.shell.archivedAt === null ? "active" : "archive",
      thread: input.shell,
    };
  }

  return {
    kind: "thread.removed",
    sequence: input.stored.sequence,
    location:
      input.stored.event.type === "thread.deleted" && input.stored.event.payload.archivedAt !== null
        ? "archive"
        : "active",
    threadId: input.stored.event.threadId,
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
