import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@spiritdevs/contracts";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export function promotedDraftCanNavigateToCanonicalThread(input: {
  readonly serverThreadStarted: boolean;
  readonly hasVisibleUserMessage: boolean;
}): boolean {
  return input.serverThreadStarted && input.hasVisibleUserMessage;
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (!input.bootstrapComplete) {
    return "loading";
  }
  if (input.draftThreadExists) {
    return "ready";
  }
  // The shell list is the same data the sidebar renders, so it outranks the
  // detail subscription's verdict: a freshly created thread can 404 on the
  // detail channel long enough to be confirmed "deleted" while cloud sync
  // already lists it. A genuinely deleted thread leaves the shell list too.
  return input.serverThreadExists ? "ready" : "missing";
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

/**
 * Resolves the thread represented by either a canonical thread route or a
 * draft route whose promotion to a server thread has been recorded.
 */
export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}

export function promotedDraftThreadIsUnavailable(input: {
  readonly hasPromotedThread: boolean;
  readonly promotedThreadExists: boolean;
  readonly promotedThreadVisible: boolean;
  readonly promotedThreadDeleted: boolean;
}): boolean {
  // While the thread is visible in the shell list it is reachable no matter
  // what the detail subscription says: a "deleted" verdict can be a 404 racing
  // the owning server's thread.create commit.
  return (
    input.hasPromotedThread &&
    !input.promotedThreadVisible &&
    (input.promotedThreadDeleted || input.promotedThreadExists)
  );
}
