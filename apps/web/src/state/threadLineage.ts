/**
 * Narrow lineage reads for the open thread. Each hook re-renders only when its own answer
 * changes, not whenever any thread in any environment updates.
 */
import { useAtomValue } from "@effect/atom-react";
import { resolveThreadForkKind } from "@spiritdevs/client-runtime/state/thread-relationships";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  breadcrumbParent,
  type ThreadBreadcrumbAncestor,
  type ThreadWithLineage,
  walkThreadBreadcrumbAncestors,
} from "../components/chat/ChatHeader";
import { getSidebarForkParentThreadId } from "../components/Sidebar.logic";
import { environmentThreadShells } from "./threads";

const EMPTY_THREAD_IDS: ReadonlyArray<ThreadId> = Object.freeze([]);
const EMPTY_ANCESTORS: ReadonlyArray<ThreadBreadcrumbAncestor> = Object.freeze([]);
const NO_SIDE_CHATS_ATOM = Atom.make(EMPTY_THREAD_IDS);
const NO_ANCESTORS_ATOM = Atom.make(EMPTY_ANCESTORS);

const sideChatThreadIdsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  let previous = EMPTY_THREAD_IDS;
  return Atom.make((get) => {
    const next = get(environmentThreadShells.environmentThreadsAtom(environmentId))
      .filter(
        (thread) =>
          getSidebarForkParentThreadId(thread) === threadId &&
          thread.settledOverride !== "settled" &&
          resolveThreadForkKind(thread) === "side_chat",
      )
      .flatMap((thread) => {
        const shell = get(
          environmentThreadShells.threadShellAtom({ environmentId, threadId: thread.id }),
        );
        return shell === null ? [] : [shell];
      })
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .map((thread) => thread.id);
    if (next.length === previous.length && next.every((id, index) => id === previous[index])) {
      return previous;
    }
    previous = next.length === 0 ? EMPTY_THREAD_IDS : next;
    return previous;
  }).pipe(Atom.withLabel(`thread-side-chats:${key}`));
});

/** Unsettled side chats forked from the thread, oldest first. */
export function useSideChatThreadIds(ref: ScopedThreadRef | null): ReadonlyArray<ThreadId> {
  return useAtomValue(
    ref === null
      ? NO_SIDE_CHATS_ATOM
      : sideChatThreadIdsAtom(JSON.stringify([ref.environmentId, ref.threadId])),
  );
}

const breadcrumbAncestorsAtom = Atom.family((key: string) => {
  const [environmentId, threadId, parentEnvironmentId, parentThreadId] = JSON.parse(key) as [
    EnvironmentId,
    ThreadId,
    EnvironmentId,
    ThreadId,
  ];
  let previous = EMPTY_ANCESTORS;
  return Atom.make((get) => {
    const next = walkThreadBreadcrumbAncestors(
      {
        id: threadId,
        title: "",
        environmentId,
        forkedFrom: null,
        lineage: { parentThreadId, parentEnvironmentId },
      },
      (parent) => get(environmentThreadShells.threadShellAtom(parent)) ?? undefined,
    );
    if (
      next.length === previous.length &&
      next.every(
        (ancestor, index) =>
          ancestor.id === previous[index]?.id &&
          ancestor.environmentId === previous[index]?.environmentId &&
          ancestor.title === previous[index]?.title,
      )
    ) {
      return previous;
    }
    previous = next.length === 0 ? EMPTY_ANCESTORS : next;
    return previous;
  }).pipe(Atom.withLabel(`thread-breadcrumb-ancestors:${key}`));
});

/** Breadcrumb ancestors of the open thread (drafts included), root first. */
export function useThreadBreadcrumbAncestors(
  thread: ThreadWithLineage | null | undefined,
): ReadonlyArray<ThreadBreadcrumbAncestor> {
  const parent = thread ? breadcrumbParent(thread) : null;
  return useAtomValue(
    thread && parent !== null
      ? breadcrumbAncestorsAtom(
          JSON.stringify([thread.environmentId, thread.id, parent.environmentId, parent.threadId]),
        )
      : NO_ANCESTORS_ATOM,
  );
}
