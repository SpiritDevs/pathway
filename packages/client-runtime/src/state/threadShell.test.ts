import {
  EnvironmentId,
  ThreadId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ProviderDriverKind,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellSnapshot,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentCatalogState } from "./connections.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import {
  createEnvironmentThreadShellAtoms,
  createThreadRosterProjector,
  pendingSubagentRequestsByThread,
} from "./threadShell.ts";
import { canSnooze, effectiveSnoozed } from "./threadSettled.ts";
import { presentThreadShell } from "./models.ts";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function snapshot(prefix: string): OrchestrationV2ShellSnapshot {
  return {
    ...v2ShellSnapshot,
    threads: [1, 2, 3].map((index) => ({
      ...v2ThreadShell,
      id: ThreadId.make(`${prefix}-${index}`),
    })),
  };
}

describe("environment thread shell atoms", () => {
  it("rebuilds only what a single shell event touches", () => {
    const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
      Atom.make<OrchestrationV2ShellSnapshot | null>(
        snapshot(environmentId === ENVIRONMENT_A ? "a" : "b"),
      ),
    );
    const shell = createEnvironmentThreadShellAtoms({
      catalogValueAtom: Atom.make<EnvironmentCatalogState>({
        isReady: true,
        entries: new Map([
          [ENVIRONMENT_A, {} as never],
          [ENVIRONMENT_B, {} as never],
        ]),
      }),
      snapshotAtom,
    });
    const registry = AtomRegistry.make();
    const firstRef = { environmentId: ENVIRONMENT_A, threadId: ThreadId.make("a-1") };
    const secondRef = { environmentId: ENVIRONMENT_A, threadId: ThreadId.make("a-2") };
    const all = registry.get(shell.threadShellsAtom);
    const listB = registry.get(shell.environmentThreadShellsAtom(ENVIRONMENT_B));
    const byProject = registry.get(shell.environmentThreadRefsByProjectAtom(ENVIRONMENT_A));
    const first = registry.get(shell.threadShellAtom(firstRef));
    const second = registry.get(shell.threadShellAtom(secondRef));
    expect(all.map((thread) => thread.id)).toEqual(["a-1", "a-2", "a-3", "b-1", "b-2", "b-3"]);
    expect(all[0]).toBe(first);

    const current = registry.get(snapshotAtom(ENVIRONMENT_A))!;
    registry.set(
      snapshotAtom(ENVIRONMENT_A),
      applyShellStreamEvent(current, {
        kind: "thread.updated",
        sequence: 1,
        location: "active",
        thread: {
          ...current.threads[0]!,
          title: "Renamed",
          subagentComposerStates: [
            {
              childThreadId: ThreadId.make("child"),
              origin: "provider_native",
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4-mini",
              options: null,
            },
          ],
        },
      }),
    );

    const nextAll = registry.get(shell.threadShellsAtom);
    expect(nextAll.map((thread) => thread.id)).toEqual(all.map((thread) => thread.id));
    expect(nextAll[0]?.title).toBe("Renamed");
    expect(first?.subagentComposerStates).toBeUndefined();
    expect(nextAll[0]?.subagentComposerStates?.[0]).toMatchObject({
      childThreadId: "child",
      origin: "provider_native",
      model: "gpt-5.4-mini",
    });
    expect(registry.get(shell.threadShellAtom(firstRef))).toBe(nextAll[0]);
    expect(registry.get(shell.threadShellAtom(secondRef))).toBe(second);
    expect(registry.get(shell.environmentThreadShellsAtom(ENVIRONMENT_B))).toBe(listB);
    expect(registry.get(shell.environmentThreadRefsByProjectAtom(ENVIRONMENT_A))).toBe(byProject);
  });
});

describe("sidebar thread roster", () => {
  const projectShell = (source: OrchestrationV2ThreadShell) =>
    presentThreadShell(ENVIRONMENT_A, source);

  it("keeps a snoozed running thread stable until a failure raises its hand", () => {
    const project = createThreadRosterProjector();
    const snoozed = {
      ...v2ThreadShell,
      status: "running" as const,
      latestRunId: RunId.make("run-snoozed"),
      latestRunRequestedAt: v2ThreadShell.createdAt,
      latestRunStartedAt: v2ThreadShell.createdAt,
      latestRunCompletedAt: null,
      latestUserMessageAt: v2ThreadShell.createdAt,
      snoozedAt: v2ThreadShell.createdAt,
      snoozedUntil: DateTime.makeUnsafe("2026-06-21T00:00:00Z"),
    };
    const roster = project([projectShell(snoozed)]);
    const streamed = { ...snoozed, updatedAt: DateTime.makeUnsafe("2026-06-20T00:01:00Z") };
    expect(project([projectShell(streamed)])).toBe(roster);
    expect(project([projectShell({ ...streamed, status: "failed" })])).not.toBe(roster);
  });

  it("refreshes membership, search, section and order fields while retaining other rows", () => {
    const other = projectShell({ ...v2ThreadShell, id: ThreadId.make("other") });
    const nextDate = DateTime.makeUnsafe("2026-06-21T00:00:00Z");
    const changes: ReadonlyArray<Partial<OrchestrationV2ThreadShell>> = [
      { title: "Renamed" },
      { projectId: null },
      { createdAt: nextDate },
      { latestUserMessageAt: nextDate },
      { archivedAt: nextDate },
      { deletedAt: nextDate },
      { settledOverride: "settled", settledAt: nextDate },
      { pinnedAt: nextDate, pinOrderKey: "n" },
      { branch: "new-branch" },
      { worktreePath: "/new/worktree" },
      {
        pendingRuntimeRequest: {
          kind: "user_input",
          id: RuntimeRequestId.make("request"),
          createdAt: nextDate,
          isBlocking: true,
        },
      },
    ];
    for (const change of changes) {
      const project = createThreadRosterProjector();
      const before = project([projectShell(v2ThreadShell), other]);
      const after = project([projectShell({ ...v2ThreadShell, ...change }), other]);
      expect(after).not.toBe(before);
      expect(after[1]).toBe(other);
      expect(project([other])).toEqual([other]);
    }
  });

  it("keeps early wake timestamps current for a pending question", () => {
    const project = createThreadRosterProjector();
    const pending = {
      ...v2ThreadShell,
      latestRunId: RunId.make("run-question"),
      status: "waiting" as const,
      latestRunRequestedAt: v2ThreadShell.createdAt,
      latestRunCompletedAt: null,
      snoozedAt: v2ThreadShell.createdAt,
      snoozedUntil: DateTime.makeUnsafe("2026-06-21T00:00:00Z"),
      pendingRuntimeRequest: {
        kind: "user_input" as const,
        id: RuntimeRequestId.make("question"),
        createdAt: v2ThreadShell.createdAt,
      },
    };
    const before = project([projectShell(pending)]);
    const after = project([
      projectShell({ ...pending, updatedAt: DateTime.makeUnsafe("2026-06-20T00:01:00Z") }),
    ]);
    expect(after).not.toBe(before);
    expect(after[0]?.runtime?.updatedAt).toBe("2026-06-20T00:01:00.000Z");
  });

  it("ignores streamed preview/error text while per-thread shells stay current", () => {
    const initial = {
      ...v2ThreadShell,
      status: "running" as const,
      latestRunId: RunId.make("run-roster"),
      latestRunRequestedAt: v2ThreadShell.createdAt,
      latestRunStartedAt: v2ThreadShell.createdAt,
      latestRunCompletedAt: null,
      latestUserMessageAt: v2ThreadShell.createdAt,
    };
    const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
      Atom.make<OrchestrationV2ShellSnapshot | null>({ ...v2ShellSnapshot, threads: [initial] }),
    );
    const shell = createEnvironmentThreadShellAtoms({
      catalogValueAtom: Atom.make<EnvironmentCatalogState>({
        isReady: true,
        entries: new Map([[ENVIRONMENT_A, {} as never]]),
      }),
      snapshotAtom,
    });
    const registry = AtomRegistry.make();
    const ref = { environmentId: ENVIRONMENT_A, threadId: initial.id };
    const roster = registry.get(shell.threadRosterAtom);
    const before = registry.get(shell.threadShellAtom(ref));
    const updatedAt = DateTime.makeUnsafe("2026-06-20T00:01:00Z");
    const update = {
      ...initial,
      updatedAt,
      lastError: "New status text",
      latestVisibleMessage: {
        id: MessageId.make("streaming"),
        role: "assistant" as const,
        text: "More streamed text",
        updatedAt,
      },
    };
    registry.set(snapshotAtom(ENVIRONMENT_A), { ...v2ShellSnapshot, threads: [update] });
    expect(registry.get(shell.threadRosterAtom)).toBe(roster);
    expect(registry.get(shell.threadShellAtom(ref))).not.toBe(before);
    expect(registry.get(shell.threadShellAtom(ref))?.runtime?.lastError).toBe("New status text");
    registry.set(snapshotAtom(ENVIRONMENT_A), {
      ...v2ShellSnapshot,
      threads: [{ ...update, pinnedAt: updatedAt }],
    });
    expect(registry.get(shell.threadRosterAtom)).not.toBe(roster);
    const pinned = registry.get(shell.threadRosterAtom);
    registry.set(snapshotAtom(ENVIRONMENT_A), {
      ...v2ShellSnapshot,
      threads: [{ ...update, pinnedAt: updatedAt, status: "failed" }],
    });
    expect(registry.get(shell.threadRosterAtom)).not.toBe(pinned);
    registry.set(snapshotAtom(ENVIRONMENT_A), { ...v2ShellSnapshot, threads: [] });
    expect(registry.get(shell.threadRosterAtom)).toEqual([]);
    registry.dispose();
  });

  it("retains the updated-at sort fallback before the first user message", () => {
    const project = createThreadRosterProjector();
    const initial = {
      ...v2ThreadShell,
      latestRunId: RunId.make("run-without-user-message"),
      latestRunRequestedAt: v2ThreadShell.createdAt,
      latestRunCompletedAt: null,
    };
    const before = project([projectShell(initial)]);
    expect(
      project([
        projectShell({ ...initial, updatedAt: DateTime.makeUnsafe("2026-06-20T00:01:00Z") }),
      ]),
    ).not.toBe(before);
  });
});

describe("subagent requests on ancestor threads", () => {
  const subagentOf = (parent: OrchestrationV2ThreadShell, id: string) => ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    creationSource: "mcp" as const,
    status: "running" as const,
    activityRunStatus: "running" as const,
    lineage: {
      rootThreadId: parent.lineage.rootThreadId,
      parentThreadId: parent.id,
      relationshipToParent: "subagent" as const,
    },
  });
  const request = (kind: "command" | "user_input", isBlocking?: boolean) => ({
    id: RuntimeRequestId.make(`request-${kind}`),
    kind,
    createdAt: v2ThreadShell.createdAt,
    ...(isBlocking === undefined ? {} : { isBlocking }),
  });

  it("lifts a nested subagent's approval to the visible thread and clears once answered", () => {
    // The parent's turn ended and is snoozed; the delegated review keeps going.
    const root = {
      ...v2ThreadShell,
      latestRunId: RunId.make("root-run"),
      status: "completed" as const,
      snoozedAt: v2ThreadShell.createdAt,
      snoozedUntil: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
    };
    const child = subagentOf(root, "review");
    const grandchild = subagentOf(child, "review-helper");
    const unrelated = { ...v2ThreadShell, id: ThreadId.make("unrelated") };
    const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
      Atom.make<OrchestrationV2ShellSnapshot | null>({
        ...v2ShellSnapshot,
        threads:
          environmentId === ENVIRONMENT_A
            ? [root, child, grandchild, unrelated]
            : [root, unrelated],
      }),
    );
    const shell = createEnvironmentThreadShellAtoms({
      catalogValueAtom: Atom.make<EnvironmentCatalogState>({
        isReady: true,
        entries: new Map([
          [ENVIRONMENT_A, {} as never],
          [ENVIRONMENT_B, {} as never],
        ]),
      }),
      snapshotAtom,
    });
    const registry = AtomRegistry.make();
    const rootRef = { environmentId: ENVIRONMENT_A, threadId: root.id };
    const now = "2026-06-20T00:00:00.000Z";
    const parent = registry.get(shell.threadShellAtom(rootRef))!;
    const roster = registry.get(shell.threadRosterAtom);
    const other = registry.get(shell.threadShellAtom({ ...rootRef, threadId: unrelated.id }));
    const listB = registry.get(shell.environmentThreadShellsAtom(ENVIRONMENT_B));
    expect(parent.pendingSubagentRequest).toBeNull();
    expect(effectiveSnoozed(parent, { now })).toBe(true);

    registry.set(snapshotAtom(ENVIRONMENT_A), {
      ...v2ShellSnapshot,
      threads: [
        root,
        child,
        { ...grandchild, pendingRuntimeRequest: request("command") },
        unrelated,
      ],
    });
    const asking = registry.get(shell.threadShellAtom(rootRef))!;
    expect(asking.pendingSubagentRequest).toBe("approval");
    expect(registry.get(shell.threadShellAtom({ ...rootRef, threadId: child.id }))).toMatchObject({
      pendingSubagentRequest: "approval",
    });
    expect(effectiveSnoozed(asking, { now })).toBe(false);
    expect(canSnooze(asking, { now })).toBe(false);
    // The roster regroups the parent, while other threads and environments keep their identity.
    expect(registry.get(shell.threadRosterAtom)).not.toBe(roster);
    expect(registry.get(shell.threadRosterAtom)).toContain(asking);
    expect(registry.get(shell.threadShellAtom({ ...rootRef, threadId: unrelated.id }))).toBe(other);
    expect(registry.get(shell.environmentThreadShellsAtom(ENVIRONMENT_B))).toBe(listB);
    expect(
      registry.get(shell.threadShellAtom({ environmentId: ENVIRONMENT_B, threadId: root.id }))
        ?.pendingSubagentRequest,
    ).toBeNull();

    registry.set(snapshotAtom(ENVIRONMENT_A), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild, unrelated],
    });
    expect(registry.get(shell.threadShellAtom(rootRef))).toBe(parent);
    expect(effectiveSnoozed(parent, { now })).toBe(true);
    registry.dispose();
  });

  it("ranks approvals over questions and ignores requests nothing waits on", () => {
    const root = v2ThreadShell;
    const asks = { ...subagentOf(root, "asks"), pendingRuntimeRequest: request("user_input") };
    const approves = { ...subagentOf(root, "approves"), pendingRuntimeRequest: request("command") };
    expect(pendingSubagentRequestsByThread([root, asks]).get(root.id)).toBe("user_input");
    expect(pendingSubagentRequestsByThread([root, asks, approves]).get(root.id)).toBe("approval");
    expect(pendingSubagentRequestsByThread([root, approves, asks]).get(root.id)).toBe("approval");

    const ignored = [
      // An async question does not hold the subagent.
      { ...subagentOf(root, "async"), pendingRuntimeRequest: request("user_input", false) },
      // The subagent's run ended, so nothing waits on its leftover question.
      {
        ...subagentOf(root, "finished"),
        status: "completed" as const,
        activityRunStatus: null,
        pendingRuntimeRequest: request("user_input"),
      },
      // A fork is not a hidden subagent row.
      {
        ...subagentOf(root, "fork"),
        lineage: { ...subagentOf(root, "fork").lineage, relationshipToParent: "fork" as const },
        pendingRuntimeRequest: request("command"),
      },
      // The parent lives on another environment, which carries its own requests.
      {
        ...subagentOf(root, "remote"),
        lineage: {
          ...subagentOf(root, "remote").lineage,
          parentEnvironmentId: ENVIRONMENT_B,
        },
        pendingRuntimeRequest: request("command"),
      },
    ];
    expect(pendingSubagentRequestsByThread([root, ...ignored]).size).toBe(0);
  });
});
