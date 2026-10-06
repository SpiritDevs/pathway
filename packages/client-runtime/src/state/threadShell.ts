import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@spiritdevs/contracts";
import { threadLastActivityAt } from "./threadSettled.ts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentThreadShell } from "./models.ts";
import { presentThreadShell } from "./models.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import {
  arrayElementsEqual,
  parseProjectRefCollectionKey,
  parseThreadKey,
  projectRefCollectionKey,
  threadKey,
  threadRefsEqual,
} from "./entities.ts";

const EMPTY_THREADS: ReadonlyArray<OrchestrationV2ThreadShell> = Object.freeze([]);
const EMPTY_SCOPED_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_THREAD_INDEX: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> = new Map();
const EMPTY_THREAD_REFS_BY_PROJECT: ReadonlyMap<
  ProjectId,
  ReadonlyArray<ScopedThreadRef>
> = new Map();

const EMPTY_THREAD_SHELLS: ReadonlyArray<EnvironmentThreadShell> = Object.freeze([]);

/** Fields used to group, classify and order the sidebar; row display fields stay per-thread. */
function threadRosterKey(thread: EnvironmentThreadShell) {
  return JSON.stringify([
    thread.id,
    thread.createdAt,
    thread.projectId,
    thread.conversationCompanyId,
    thread.title,
    thread.temporary,
    thread.keptAt,
    thread.branch,
    thread.worktreePath,
    thread.lineage,
    thread.forkKind,
    thread.locations,
    thread.forkedFrom,
    thread.archivedAt,
    thread.deletedAt,
    thread.settledOverride,
    thread.settledAt,
    thread.settleAfterCompletion,
    thread.snoozedUntil,
    thread.snoozedAt,
    thread.pinnedAt,
    thread.pinOrderKey,
    thread.hasPendingApprovals,
    thread.hasPendingUserInput,
    thread.runtime?.status,
    thread.runtime?.allowanceHold,
    thread.snoozedUntil != null &&
    (thread.runtime?.status === "failed" ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput)
      ? thread.runtime?.updatedAt
      : null,
    thread.latestRun,
    thread.latestUserMessageAt ?? thread.updatedAt,
    thread.settledAt ?? threadLastActivityAt(thread) ?? thread.updatedAt,
    thread.attachedPullRequest,
    thread.attachedPullRequests,
    thread.detachedPullRequestUrls,
    thread.pendingBackgroundTasks.length,
  ]);
}

/** Roster snapshots deliberately stay stable when only a row's text/content changes. */
export function createThreadRosterProjector() {
  let previous = EMPTY_THREAD_SHELLS;
  let entries = new Map<
    ThreadId,
    { source: EnvironmentThreadShell; key: string; roster: EnvironmentThreadShell }
  >();
  return (threads: ReadonlyArray<EnvironmentThreadShell>) => {
    const nextEntries = new Map<
      ThreadId,
      { source: EnvironmentThreadShell; key: string; roster: EnvironmentThreadShell }
    >();
    const next = threads.map((source) => {
      const old = entries.get(source.id);
      if (old?.source === source) {
        nextEntries.set(source.id, old);
        return old.roster;
      }
      const key = threadRosterKey(source);
      const roster = old?.key === key ? old.roster : source;
      nextEntries.set(source.id, { source, key, roster });
      return roster;
    });
    entries = nextEntries;
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return previous;
  };
}

export function createEnvironmentThreadShellAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  /** Cloud discovery fallback used only until the owning environment supplies a shell. */
  readonly fallbackThreadsAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadShell>>;
}) {
  // Shell sources are immutable and keep their identity until they change, so
  // one presentation per source is shared by the list and per-thread atoms.
  const presentedByEnvironment = new Map<
    EnvironmentId,
    WeakMap<OrchestrationV2ThreadShell, EnvironmentThreadShell>
  >();
  const present = (environmentId: EnvironmentId, source: OrchestrationV2ThreadShell) => {
    let cache = presentedByEnvironment.get(environmentId);
    if (cache === undefined) {
      cache = new WeakMap();
      presentedByEnvironment.set(environmentId, cache);
    }
    let value = cache.get(source);
    if (value === undefined) {
      value = presentThreadShell(environmentId, source);
      cache.set(source, value);
    }
    return value;
  };

  const environmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyArray<OrchestrationV2ThreadShell> => {
      const snapshot = get(input.snapshotAtom(environmentId));
      if (snapshot !== null) return snapshot.threads;
      return input.fallbackThreadsAtom === undefined
        ? EMPTY_THREADS
        : get(input.fallbackThreadsAtom(environmentId));
    }).pipe(Atom.withLabel(`environment-threads:${environmentId}`)),
  );

  const environmentThreadIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> => {
      const threads = get(environmentThreadsAtom(environmentId));
      if (threads.length === 0) {
        return EMPTY_THREAD_INDEX;
      }
      return new Map(threads.map((thread) => [thread.id, thread] as const));
    }).pipe(Atom.withLabel(`environment-thread-index:${environmentId}`)),
  );

  const environmentThreadRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedThreadRef> = [];
    return Atom.make((get) => {
      const next = get(environmentThreadsAtom(environmentId)).map((thread) => ({
        environmentId,
        threadId: thread.id,
      }));
      if (threadRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-refs:${environmentId}`));
  });

  const environmentThreadRefsByProjectAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyMap<
      ProjectId,
      ReadonlyArray<ScopedThreadRef>
    > = EMPTY_THREAD_REFS_BY_PROJECT;
    return Atom.make((get) => {
      const grouped = new Map<ProjectId, ScopedThreadRef[]>();
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        if (thread.projectId === null) continue;
        const refs = grouped.get(thread.projectId);
        const ref = { environmentId, threadId: thread.id };
        if (refs === undefined) {
          grouped.set(thread.projectId, [ref]);
        } else {
          refs.push(ref);
        }
      }
      if (grouped.size === 0) {
        previous = EMPTY_THREAD_REFS_BY_PROJECT;
        return previous;
      }
      const next = new Map<ProjectId, ReadonlyArray<ScopedThreadRef>>();
      let changed = grouped.size !== previous.size;
      for (const [projectId, refs] of grouped) {
        const previousRefs = previous.get(projectId);
        const unchanged = previousRefs !== undefined && threadRefsEqual(previousRefs, refs);
        changed ||= !unchanged;
        next.set(projectId, unchanged ? previousRefs : refs);
      }
      if (!changed) return previous;
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-refs-by-project:${environmentId}`));
  });

  const threadShellAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const source = get(environmentThreadIndexAtom(ref.environmentId)).get(ref.threadId);
      return source === undefined ? null : present(ref.environmentId, source);
    }).pipe(Atom.withLabel(`environment-thread-shell:${key}`));
  });

  const environmentThreadShellsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_THREAD_SHELLS;
    return Atom.make((get) => {
      const next = get(environmentThreadsAtom(environmentId)).map((thread) =>
        present(environmentId, thread),
      );
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-shells:${environmentId}`));
  });

  const environmentThreadRosterAtom = Atom.family((environmentId: EnvironmentId) => {
    const project = createThreadRosterProjector();
    return Atom.make((get) => project(get(environmentThreadShellsAtom(environmentId)))).pipe(
      Atom.withLabel(`environment-thread-roster:${environmentId}`),
    );
  });

  const threadShellsForProjectRefsAtomFamily = Atom.family((key: string) => {
    const projectRefs = parseProjectRefCollectionKey(key);
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const next: EnvironmentThreadShell[] = [];
      const seen = new Set<string>();
      for (const projectRef of projectRefs) {
        const refs =
          get(environmentThreadRefsByProjectAtom(projectRef.environmentId)).get(
            projectRef.projectId,
          ) ?? EMPTY_SCOPED_THREAD_REFS;
        for (const ref of refs) {
          const key = threadKey(ref);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const thread = get(threadShellAtomFamily(key));
          if (thread !== null) {
            next.push(thread);
          }
        }
      }
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-shells-for-projects:${key}`));
  });

  let previousThreadRefs: ReadonlyArray<ScopedThreadRef> = [];
  const threadRefsAtom = Atom.make((get) => {
    const refs: ScopedThreadRef[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      refs.push(...get(environmentThreadRefsAtom(environmentId)));
    }
    if (threadRefsEqual(previousThreadRefs, refs)) {
      return previousThreadRefs;
    }
    previousThreadRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-thread-refs"));

  // Concatenates per-environment lists, so a shell event rebuilds only its own
  // environment's list instead of re-reading every per-thread atom.
  let previousThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const threadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      next.push(...get(environmentThreadShellsAtom(environmentId)));
    }
    if (arrayElementsEqual(previousThreadShells, next)) {
      return previousThreadShells;
    }
    previousThreadShells = next;
    return previousThreadShells;
  }).pipe(Atom.withLabel("environment-thread-shell-list"));

  let previousRoster = EMPTY_THREAD_SHELLS;
  const threadRosterAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      next.push(...get(environmentThreadRosterAtom(environmentId)));
    }
    if (arrayElementsEqual(previousRoster, next)) return previousRoster;
    previousRoster = next;
    return previousRoster;
  }).pipe(Atom.withLabel("environment-thread-roster"));

  return {
    threadRosterAtom,
    environmentThreadRosterAtom,
    environmentThreadsAtom,
    environmentThreadIndexAtom,
    environmentThreadRefsAtom,
    environmentThreadRefsByProjectAtom,
    environmentThreadShellsAtom,
    threadRefsAtom,
    threadShellsAtom,
    threadShellsForProjectRefsAtom: (refs: ReadonlyArray<ScopedProjectRef>) =>
      threadShellsForProjectRefsAtomFamily(projectRefCollectionKey(refs)),
    threadShellAtom: (ref: ScopedThreadRef) => threadShellAtomFamily(threadKey(ref)),
  };
}
