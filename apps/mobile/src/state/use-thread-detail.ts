import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2BrowserTakeoverFailure,
  OrchestrationV2BrowserTakeoverStatus,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails, useEnvironmentThread } from "./threads";
import { useThreadSelection } from "./use-thread-selection";

const EMPTY_THREAD_PROJECTION_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("mobile-thread-projection:empty"),
);
const EMPTY_VISIBLE_TURN_ITEMS_ATOM = Atom.make<
  OrchestrationV2ThreadProjection["visibleTurnItems"]
>(Object.freeze([])).pipe(Atom.withLabel("mobile-thread-visible-turn-items:empty"));

export interface ThreadDetailTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}

export function useThreadDetail(target: ThreadDetailTarget) {
  return useEnvironmentThread(target.environmentId, target.threadId);
}

export function useSelectedThreadDetailState() {
  const { selectedThread } = useThreadSelection();
  return useThreadDetail({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
}

export function useThreadProjection(target: ThreadDetailTarget): EnvironmentThread | null {
  return useAtomValue(
    target.environmentId === null || target.threadId === null
      ? EMPTY_THREAD_PROJECTION_ATOM
      : environmentThreadDetails.threadAtom({
          environmentId: target.environmentId,
          threadId: target.threadId,
        }),
  );
}

export function useSelectedThreadProjection(): EnvironmentThread | null {
  const { selectedThread } = useThreadSelection();
  return useThreadProjection({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
}

/**
 * Browser takeover status for a thread, read one primitive at a time: the
 * composer must not re-render on every streamed projection change, and both
 * fields are plain strings so the selector subscriptions stay stable.
 * Both are null on pre-takeover servers, which omit the field entirely.
 */
export function useThreadBrowserTakeoverStatus(target: ThreadDetailTarget): {
  readonly status: OrchestrationV2BrowserTakeoverStatus | null;
  readonly failure: OrchestrationV2BrowserTakeoverFailure | null;
} {
  const atom =
    target.environmentId === null || target.threadId === null
      ? EMPTY_THREAD_PROJECTION_ATOM
      : environmentThreadDetails.threadAtom({
          environmentId: target.environmentId,
          threadId: target.threadId,
        });
  const status = useAtomValue(
    atom,
    (thread) => thread?.projection.thread.browserTakeover?.status ?? null,
  );
  const failure = useAtomValue(
    atom,
    (thread) => thread?.projection.thread.browserTakeover?.failure ?? null,
  );
  return { status, failure };
}

export function useThreadVisibleTurnItems(
  target: ThreadDetailTarget,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  return useAtomValue(
    target.environmentId === null || target.threadId === null
      ? EMPTY_VISIBLE_TURN_ITEMS_ATOM
      : environmentThreadDetails.visibleTurnItemsAtom({
          environmentId: target.environmentId,
          threadId: target.threadId,
        }),
  );
}

export function useSelectedThreadVisibleTurnItems(): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const { selectedThread } = useThreadSelection();
  return useThreadVisibleTurnItems({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
}
