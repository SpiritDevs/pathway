import { describe, expect, it } from "@effect/vitest";
import type {
  ApplicationStoredEvent,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadShell,
} from "@spiritdevs/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { mergeShellSnapshotProjects } from "@spiritdevs/client-runtime/state/shell";

import {
  archivedShellStreamItemFromThreadShell,
  coalesceShellApplicationEvents,
  coalesceStoredThreadEvents,
  composeShellStreamWithEnrichment,
  enrichmentRefreshes,
  makeDeliveredRepositoryIdentities,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
} from "./ShellStream.ts";

function project(sequence: number, id: string): ApplicationStoredEvent {
  return {
    sequence,
    aggregateKind: "project",
    aggregateId: id,
  } as ApplicationStoredEvent;
}

function thread(sequence: number, id: string): ApplicationStoredEvent {
  return {
    sequence,
    event: { threadId: id },
  } as ApplicationStoredEvent;
}

const emptyShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
} as OrchestrationV2ShellSnapshot;

describe("coalesceShellApplicationEvents", () => {
  it("keeps the newest event per aggregate and preserves sequence order", () => {
    expect(
      coalesceShellApplicationEvents([
        thread(2, "thread-a"),
        project(3, "project-a"),
        thread(4, "thread-b"),
        thread(5, "thread-a"),
        project(6, "project-a"),
      ]).map((event) => event.sequence),
    ).toEqual([4, 5, 6]);
  });
});

function storedThreadEvent(
  sequence: number,
  threadId: string,
  event: Record<string, unknown> = {},
): OrchestrationV2StoredEvent {
  return { sequence, event: { threadId, ...event } } as OrchestrationV2StoredEvent;
}

function shellFixture(overrides: Partial<OrchestrationV2ThreadShell>): OrchestrationV2ThreadShell {
  return { id: "thread-a", archivedAt: null, ...overrides } as OrchestrationV2ThreadShell;
}

describe("coalesceStoredThreadEvents", () => {
  it("keeps the newest stored event per thread and preserves sequence order", () => {
    expect(
      coalesceStoredThreadEvents([
        storedThreadEvent(2, "thread-a"),
        storedThreadEvent(3, "thread-b"),
        storedThreadEvent(5, "thread-a"),
      ]).map((stored) => stored.sequence),
    ).toEqual([3, 5]);
  });
});

describe("shellStreamItemFromThreadShell", () => {
  it("emits an active thread update when the shell is not archived", () => {
    const shell = shellFixture({ archivedAt: null });
    expect(
      shellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({
      kind: "thread.updated",
      sequence: 4,
      location: "active",
      thread: shell,
    });
  });

  it("emits an archive update when the shell is archived", () => {
    const shell = shellFixture({ archivedAt: "2026-07-30T00:00:00.000Z" as never });
    expect(
      shellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({
      kind: "thread.updated",
      sequence: 4,
      location: "archive",
      thread: shell,
    });
  });

  it("emits a removal from the archive when an archived thread is deleted", () => {
    expect(
      shellStreamItemFromThreadShell({
        stored: storedThreadEvent(6, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: "2026-07-30T00:00:00.000Z" },
        }),
        shell: null,
      }),
    ).toEqual({
      kind: "thread.removed",
      sequence: 6,
      location: "archive",
      threadId: "thread-a",
    });
  });

  it("emits a removal from the active list for other missing shells", () => {
    expect(
      shellStreamItemFromThreadShell({
        stored: storedThreadEvent(6, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: null },
        }),
        shell: null,
      }),
    ).toEqual({
      kind: "thread.removed",
      sequence: 6,
      location: "active",
      threadId: "thread-a",
    });
  });
});

describe("archivedShellStreamItemFromThreadShell", () => {
  it("emits an update for an archived shell", () => {
    const shell = shellFixture({ archivedAt: "2026-07-30T00:00:00.000Z" as never });
    expect(
      archivedShellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({ kind: "thread.updated", sequence: 4, thread: shell });
  });

  it("ignores active threads that never touched the archive", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", { type: "thread.settled" }),
        shell: shellFixture({ archivedAt: null }),
      }),
    ).toBeNull();
  });

  it("emits a removal when a thread leaves the archive", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", { type: "thread.unarchived" }),
        shell: shellFixture({ archivedAt: null }),
      }),
    ).toEqual({ kind: "thread.removed", sequence: 4, threadId: "thread-a" });
  });

  it("emits a removal when an archived thread is deleted", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: "2026-07-30T00:00:00.000Z" },
        }),
        shell: null,
      }),
    ).toEqual({ kind: "thread.removed", sequence: 4, threadId: "thread-a" });
  });
});

describe("shellStreamItemFromEnrichmentRefresh", () => {
  it("batches nearby completion roots onto one snapshot item", () => {
    expect(
      shellStreamItemFromEnrichmentRefresh({
        snapshot: emptyShellSnapshot,
        changes: [
          { workspaceRoot: "/workspace/a" },
          { workspaceRoot: "/workspace/b" },
          { workspaceRoot: "/workspace/a" },
        ],
      }),
    ).toEqual({
      kind: "snapshot",
      snapshot: emptyShellSnapshot,
      resolvedRepositoryIdentityRoots: ["/workspace/a", "/workspace/b"],
    });
  });
});

describe("shellStreamItemsFromInitialSnapshot", () => {
  it("emits unmarked authoritative then same-sequence marked enrichment when roots resolved", () => {
    const snapshot = {
      ...emptyShellSnapshot,
      snapshotSequence: 7,
    } as OrchestrationV2ShellSnapshot;

    expect(
      shellStreamItemsFromInitialSnapshot({
        snapshot,
        resolvedRepositoryIdentityRoots: ["/workspace/a", "/workspace/a"],
      }),
    ).toEqual([
      { kind: "snapshot", snapshot },
      {
        kind: "snapshot",
        snapshot,
        resolvedRepositoryIdentityRoots: ["/workspace/a"],
      },
    ]);
  });

  it("emits only the unmarked authoritative snapshot when no roots resolved", () => {
    expect(
      shellStreamItemsFromInitialSnapshot({
        snapshot: emptyShellSnapshot,
        resolvedRepositoryIdentityRoots: [],
      }),
    ).toEqual([{ kind: "snapshot", snapshot: emptyShellSnapshot }]);
    expect(
      shellStreamItemsFromInitialSnapshot({
        snapshot: emptyShellSnapshot,
        resolvedRepositoryIdentityRoots: [],
        resume: true,
      }),
    ).toEqual([{ kind: "snapshot", snapshot: emptyShellSnapshot }]);
  });

  it("resumes with the marked frame alone and leaves clients in the same state", () => {
    const identity = (name: string) =>
      ({ canonicalKey: `github.com/pathway/${name}`, locator: {} }) as never;
    const projectShell = (repositoryIdentity: unknown) =>
      ({
        id: "project-a",
        workspaceRoot: "/workspace/a",
        repositoryIdentity,
      }) as unknown as OrchestrationV2ShellSnapshot["projects"][number];
    const threadShell = (id: string) => ({ id }) as unknown as OrchestrationV2ThreadShell;
    const cached = {
      ...emptyShellSnapshot,
      snapshotSequence: 7,
      projects: [projectShell(identity("old"))],
      threads: [threadShell("thread-a")],
    } as OrchestrationV2ShellSnapshot;
    const apply = (
      frames: ReadonlyArray<ReturnType<typeof shellStreamItemsFromInitialSnapshot>[number]>,
      understandsMarker: boolean,
    ) =>
      frames.reduce(
        (state, frame) =>
          mergeShellSnapshotProjects(
            state,
            frame.snapshot,
            understandsMarker && frame.resolvedRepositoryIdentityRoots !== undefined
              ? { resolvedRepositoryIdentityRoots: frame.resolvedRepositoryIdentityRoots }
              : undefined,
          ),
        cached,
      );

    // The same sequence carries the same structure; a newer one adds a thread.
    for (const snapshotSequence of [7, 9]) {
      const snapshot = {
        ...emptyShellSnapshot,
        snapshotSequence,
        projects: [projectShell(null)],
        threads:
          snapshotSequence === 7
            ? cached.threads
            : [threadShell("thread-a"), threadShell("thread-b")],
      } as OrchestrationV2ShellSnapshot;
      const input = { snapshot, resolvedRepositoryIdentityRoots: ["/workspace/a"] };
      const resumed = shellStreamItemsFromInitialSnapshot({ ...input, resume: true });
      expect(resumed).toHaveLength(1);
      for (const understandsMarker of [true, false]) {
        expect(apply(resumed, understandsMarker)).toEqual(
          apply(shellStreamItemsFromInitialSnapshot(input), understandsMarker),
        );
      }
    }
  });
});

describe("enrichmentRefreshes", () => {
  it.effect("reloads only for batches that change an identity the subscriber holds", () =>
    Effect.gen(function* () {
      const change = (
        workspaceRoot: string,
        repositoryIdentity: unknown,
        repositoryIdentityResolved = true,
      ) => ({ workspaceRoot, repositoryIdentityResolved, enrichment: { repositoryIdentity } });
      const changes = yield* Queue.unbounded<ReturnType<typeof change>, Cause.Done>();
      const delivered = makeDeliveredRepositoryIdentities();
      delivered.recordSnapshot(
        {
          ...emptyShellSnapshot,
          projects: [{ id: "a", workspaceRoot: "/workspace/a", repositoryIdentity: { key: "a" } }],
        } as unknown as OrchestrationV2ShellSnapshot,
        ["/workspace/a"],
      );
      const refreshed: Array<ReadonlyArray<string>> = [];
      const fiber = yield* enrichmentRefreshes({
        changes: Stream.fromQueue(changes),
        delivered,
        refresh: (batch) =>
          Effect.sync(() => refreshed.push(batch.map((entry) => entry.workspaceRoot))),
      }).pipe(Stream.runDrain, Effect.forkChild);

      // A cache-expiry re-resolution and a failed probe: nothing to send.
      yield* Queue.offerAll(changes, [
        change("/workspace/a", { key: "a" }),
        change("/workspace/b", null, false),
      ]);
      yield* TestClock.adjust("25 millis");
      expect(refreshed).toEqual([]);

      yield* Queue.offerAll(changes, [
        change("/workspace/a", { key: "moved" }),
        change("/workspace/c", null),
      ]);
      yield* TestClock.adjust("25 millis");
      yield* Queue.end(changes);
      yield* Fiber.join(fiber);
      expect(refreshed).toEqual([["/workspace/a", "/workspace/c"]]);
    }),
  );
});

describe("makeDeliveredRepositoryIdentities", () => {
  const change = (workspaceRoot: string, repositoryIdentity: unknown) => ({
    workspaceRoot,
    enrichment: { repositoryIdentity },
  });

  it("drops re-resolutions of identities the subscriber already holds", () => {
    const delivered = makeDeliveredRepositoryIdentities();
    delivered.recordSnapshot(
      {
        ...emptyShellSnapshot,
        projects: [
          { id: "a", workspaceRoot: "/workspace/a", repositoryIdentity: { key: "a" } },
          { id: "b", workspaceRoot: "/workspace/b", repositoryIdentity: null },
        ],
      } as unknown as OrchestrationV2ShellSnapshot,
      ["/workspace/a"],
    );

    expect(
      delivered.takeUndelivered([
        change("/workspace/a", { key: "a" }),
        change("/workspace/b", null),
      ]),
    ).toEqual([change("/workspace/b", null)]);
    expect(delivered.takeUndelivered([change("/workspace/b", null)])).toEqual([]);
    expect(delivered.takeUndelivered([change("/workspace/a", { key: "moved" })])).toEqual([
      change("/workspace/a", { key: "moved" }),
    ]);
  });

  it("keeps only the newest completion per root in a batch", () => {
    const delivered = makeDeliveredRepositoryIdentities();
    expect(
      delivered.takeUndelivered([
        change("/workspace/a", { key: "first" }),
        change("/workspace/a", { key: "second" }),
      ]),
    ).toEqual([change("/workspace/a", { key: "second" })]);
  });
});

describe("composeShellStreamWithEnrichment", () => {
  it.effect(
    "emits every initial item before enrichment even when enrichment is already ready",
    () =>
      Effect.gen(function* () {
        const initialSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 5,
        } as OrchestrationV2ShellSnapshot;
        const enrichmentSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 10,
        } as OrchestrationV2ShellSnapshot;

        const initialItems = shellStreamItemsFromInitialSnapshot({
          snapshot: initialSnapshot,
          resolvedRepositoryIdentityRoots: ["/workspace/a"],
        });
        // Enrichment stream is fully ready before the composed stream is pulled.
        const enrichment = Stream.make(
          shellStreamItemFromEnrichmentRefresh({
            snapshot: enrichmentSnapshot,
            changes: [{ workspaceRoot: "/workspace/b" }],
          }),
        );
        const tail = Stream.make(
          { kind: "synchronized" as const },
          {
            kind: "project.removed" as const,
            sequence: 6,
            projectId: "project-a",
          },
        );

        const items = Array.from(
          yield* composeShellStreamWithEnrichment({
            initial: Stream.fromIterable(initialItems),
            tail,
            enrichment,
          }).pipe(Stream.runCollect),
        );

        expect(items.slice(0, initialItems.length)).toEqual(initialItems);

        const enrichmentIndex = items.findIndex(
          (item) =>
            item.kind === "snapshot" &&
            "resolvedRepositoryIdentityRoots" in item &&
            item.resolvedRepositoryIdentityRoots?.includes("/workspace/b"),
        );
        expect(enrichmentIndex).toBeGreaterThanOrEqual(initialItems.length);

        for (let index = 0; index < initialItems.length; index++) {
          expect(items[index]).toEqual(initialItems[index]);
        }
      }),
  );

  it.effect("still interleaves enrichment with the post-prefix tail after initials drain", () =>
    Effect.gen(function* () {
      const items = Array.from(
        yield* composeShellStreamWithEnrichment({
          initial: Stream.make("initial-unmarked", "initial-marked"),
          tail: Stream.make("tail-a", "tail-b"),
          enrichment: Stream.make("enrichment"),
        }).pipe(Stream.runCollect),
      );

      expect(items.slice(0, 2)).toEqual(["initial-unmarked", "initial-marked"]);
      expect(items).toContain("enrichment");
      expect(items).toContain("tail-a");
      expect(items).toContain("tail-b");
      expect(items.indexOf("enrichment")).toBeGreaterThanOrEqual(2);
    }),
  );
});
