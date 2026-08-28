import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect } from "react";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import {
  buildThreadRouteParams,
  promotedDraftCanNavigateToCanonicalThread,
  promotedDraftThreadIsUnavailable,
} from "../threadRoutes";
import {
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
  useThreadVisibleTurnItems,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThreadShell(serverThreadRef);
  const serverThreadStatus = useThreadStatus(serverThreadRef);
  const unfilteredEnvironmentShell = useEnvironmentQuery(
    serverThreadRef === null ? null : environmentShell.stateAtom(serverThreadRef.environmentId),
  );
  const unfilteredSnapshot =
    unfilteredEnvironmentShell.data === null
      ? null
      : Option.getOrNull(unfilteredEnvironmentShell.data.snapshot);
  const promotedThreadUnavailable = promotedDraftThreadIsUnavailable({
    hasPromotedThread: draftSession?.promotedTo != null,
    promotedThreadExists:
      serverThreadRef !== null &&
      (unfilteredSnapshot?.threads.some((thread) => thread.id === serverThreadRef.threadId) ??
        false),
    promotedThreadVisible: serverThread !== null,
    promotedThreadDeleted: serverThreadStatus === "deleted",
  });
  const serverThreadStarted = threadHasStarted(serverThread);
  const serverVisibleTurnItems = useThreadVisibleTurnItems(serverThreadRef);
  // ChatView owns the optimistic first message while this draft route stays
  // mounted. Do not remount it on the canonical route until that message is
  // present in the server projection, or the user briefly sees an empty chat.
  const canonicalThreadRef = promotedDraftCanNavigateToCanonicalThread({
    serverThreadStarted,
    hasVisibleUserMessage: serverVisibleTurnItems.some((row) => row.item.type === "user_message"),
  })
    ? serverThreadRef
    : null;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }

    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/threads/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (!promotedThreadUnavailable) return;
    void navigate({ to: "/threads", replace: true });
  }, [navigate, promotedThreadUnavailable]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/threads", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (!draftSession || promotedThreadUnavailable) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        forceExpandedMobileComposer
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/threads_/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
