import { useAtomValue } from "@effect/atom-react";
import {
  threadQueueEntriesAtom,
  threadQueueHydratedAtom,
  findQueuedThread,
  parseQueuedThreadSearch,
  isCompletedQueueEntry,
} from "../cloud/threadQueueState";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";
import { PlusIcon } from "lucide-react";
import { useEffect } from "react";

import threadNotFoundUrl from "../assets/thread-not-found.png?url";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  promotedDraftThreadIsUnavailable,
  resolveThreadRouteRef,
  resolveThreadRouteRenderState,
} from "../threadRoutes";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { SidebarInset } from "~/components/ui/sidebar";
import { environmentCatalog } from "../connection/catalog";
import { resolveThreadDetailRef, useThreadShell, useThreadStatus } from "../state/entities";
import { environmentSnapshotAtom } from "../state/shell";

/**
 * The only facts the route needs from the (unfiltered) shell stream. A string keeps the route,
 * and the chat view under it, from re-rendering when unrelated threads update. A thread in an
 * environment this client does not know is absent: that shell would never load.
 */
const threadRouteShellPresenceAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    const catalog = get(environmentCatalog.catalogValueAtom);
    if (catalog.isReady && !catalog.entries.has(environmentId)) return "absent" as const;
    const snapshot = get(environmentSnapshotAtom(environmentId));
    if (snapshot === null) return "loading" as const;
    return snapshot.threads.some((thread) => thread.id === threadId)
      ? ("present" as const)
      : ("absent" as const);
  }).pipe(Atom.withLabel(`thread-route-shell-presence:${key}`));
});
const NO_THREAD_ROUTE_SHELL_ATOM = Atom.make("loading" as const);

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shellPresence = useAtomValue(
    threadRef === null
      ? NO_THREAD_ROUTE_SHELL_ATOM
      : threadRouteShellPresenceAtom(JSON.stringify([threadRef.environmentId, threadRef.threadId])),
  );
  const queuedThreads = useAtomValue(threadQueueEntriesAtom);
  const { queueId } = Route.useSearch();
  const queueHydrated = useAtomValue(threadQueueHydratedAtom);
  const queuedThread = queueId
    ? queuedThreads.find((row) => row.queueId === queueId && row.threadId === threadRef?.threadId)
    : findQueuedThread(queuedThreads, threadRef?.environmentId, threadRef?.threadId);
  const serverThreadShell = useThreadShell(threadRef);
  const completedQueue = queuedThread !== undefined && isCompletedQueueEntry(queuedThread);
  const unavailableQueue =
    queueHydrated &&
    serverThreadShell === null &&
    (completedQueue || (queueId !== undefined && !queuedThread));
  const bootstrapComplete = shellPresence !== "loading";
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  // Until a draft's first send reaches the shell, its server thread may not
  // exist; a premature not-found would close the optimistic thread.
  const serverThreadStatus = useThreadStatus(
    resolveThreadDetailRef(threadRef, {
      shellExists: serverThreadShell !== null,
      waitForShell: draftThread !== null && !draftThread.promotedTo,
    }),
  );
  const promotedThreadUnavailable = promotedDraftThreadIsUnavailable({
    hasPromotedThread: draftThreadExists && !queuedThread,
    promotedThreadExists: shellPresence === "present",
    promotedThreadVisible: serverThreadShell !== null,
    promotedThreadDeleted: serverThreadStatus === "deleted",
  });
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    draftThreadExists: draftThreadExists && !promotedThreadUnavailable,
  });
  useEffect(() => {
    if (!queuedThread) return;
    const currentEnvironmentId = threadRef?.environmentId;
    if (queuedThread.environmentId === currentEnvironmentId) return;
    void navigate({
      to: "/threads/$environmentId/$threadId",
      params: { environmentId: queuedThread.environmentId, threadId: queuedThread.threadId },
      search: queuedThread.queueId ? { queueId: queuedThread.queueId } : {},
      replace: true,
    });
  }, [navigate, queuedThread, threadRef]);
  const serverThreadStarted = threadHasStarted(serverThreadShell);

  const threadMissing = renderState === "missing" && !queuedThread && !queueId;

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {unavailableQueue ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
          role="status"
        >
          <h1 className="text-lg font-medium">This thread is not available</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {completedQueue
              ? "Your message was delivered, but its conversation is not currently available. There is no work waiting in this queue."
              : "This saved queue entry is no longer available."}
          </p>
          <Link to="/threads" className="text-sm underline underline-offset-4">
            Back to threads
          </Link>
        </div>
      ) : threadMissing ? (
        <ThreadNotFound />
      ) : (
          queuedThread
            ? queuedThread.environmentId === threadRef.environmentId
            : renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)
        ) ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
        />
      ) : null}
    </SidebarInset>
  );
}

function ThreadNotFound() {
  return (
    <Empty className="flex-1">
      <EmptyHeader className="max-w-md">
        <img
          src={threadNotFoundUrl}
          alt=""
          width={160}
          height={120}
          className="mx-auto mb-4 select-none opacity-70 dark:opacity-40 dark:invert"
          draggable={false}
        />
        <EmptyTitle className="text-foreground text-xl">Couldn’t find this thread</EmptyTitle>
        <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
          It may have been deleted, or it belongs to an environment this device isn’t connected to.
        </EmptyDescription>
        <div className="mt-5 flex justify-center">
          <Button render={<Link to="/threads" />} size="sm">
            <PlusIcon className="size-4" />
            Start new chat
          </Button>
        </div>
      </EmptyHeader>
    </Empty>
  );
}

export const Route = createFileRoute("/_chat/threads_/$environmentId/$threadId")({
  validateSearch: parseQueuedThreadSearch,
  component: ChatThreadRouteView,
});
