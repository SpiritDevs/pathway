import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ConversationShareSession,
  EnvironmentAuthorizationError,
  conversationShareIdFromSubject,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import { convexHttpClientLike } from "../cloud/convexSyncTransport.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "../cloud/syncDaemon.ts";

const sessionReference = makeFunctionReference<
  "query",
  { environmentId: string; shareId: string },
  unknown
>("conversationShares:session");
const decodeSession = Schema.decodeUnknownOption(ConversationShareSession);

export type ThreadAccessAction = "read" | "collaborate" | "manage";
export type AccessThread = Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "ownerUserId">;
export interface AccessPrincipal {
  readonly subject: string;
  readonly scopes: readonly AuthEnvironmentScope[];
  readonly initiatingEnvironmentId?: EnvironmentId;
}

export function canAccessConversation(input: {
  readonly principal: AccessPrincipal;
  readonly linkedOwnerUserId: string | null;
  readonly thread: AccessThread;
  readonly share: ConversationShareSession | null;
  readonly action: ThreadAccessAction;
}): boolean {
  const shareId = conversationShareIdFromSubject(input.principal.subject);
  if (shareId !== null) {
    const permission = input.share?.conversations.find(
      (conversation) => conversation.threadId === input.thread.id,
    );
    return (
      input.share !== null &&
      input.share.shareId === shareId &&
      permission !== undefined &&
      input.thread.projectId === null &&
      permission.ownerUserId === input.thread.ownerUserId &&
      input.action !== "manage" &&
      (input.action === "read" || permission.access === "collaborate")
    );
  }
  if (input.thread.projectId !== null) return true;
  if (input.principal.scopes.includes(AuthAccessWriteScope)) return true;
  const trustedOwnerSession = [
    "desktop-bootstrap",
    "administrative-bootstrap",
    "one-time-token",
    "cloud-connect",
    "cli-issued-session",
    "browser",
  ].includes(input.principal.subject);
  return (
    trustedOwnerSession &&
    (input.thread.ownerUserId === undefined ||
      (input.linkedOwnerUserId !== null && input.thread.ownerUserId === input.linkedOwnerUserId))
  );
}

export const readConversationOwnerUserId = Effect.fn("conversationSharing.readOwner")(function* () {
  const secrets = yield* ServerSecretStore;
  const value = yield* secrets.get(CLOUD_LINKED_USER_ID).pipe(Effect.option);
  return Option.isSome(value) && Option.isSome(value.value)
    ? new TextDecoder().decode(value.value.value)
    : null;
});

export const resolveConversationShareForEnvironment = Effect.fn(
  "conversationSharing.resolveSession",
)(
  function* (input: { environmentId: EnvironmentId; shareId: string }) {
    const config = yield* resolveCloudSyncConfig;
    if (config._tag !== "Configured") return null;
    const secrets = yield* ServerSecretStore;
    const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
    const tokens = yield* makeCloudSyncTokenProvider({
      environmentId: input.environmentId,
      secrets,
      dpopKeys,
    });
    const token = yield* tokens.token;
    const client = convexHttpClientLike(config.settings.convexUrl);
    const value = yield* Effect.tryPromise(() => {
      client.setAuth(token);
      return client.query(sessionReference, input);
    });
    const decoded = decodeSession(value);
    return Option.isSome(decoded) ? decoded.value : null;
  },
  Effect.orElseSucceed(() => null),
);

export const makeThreadAccessRequest = Effect.fn("conversationSharing.makeThreadAccessRequest")(
  function* (principal: AccessPrincipal, environmentId: EnvironmentId) {
    const linkedOwnerUserId = yield* readConversationOwnerUserId();
    const shareId = conversationShareIdFromSubject(principal.subject);
    const share =
      shareId === null
        ? null
        : yield* resolveConversationShareForEnvironment({ environmentId, shareId });
    return {
      restricted: shareId !== null,
      canAccess: (thread: AccessThread, action: ThreadAccessAction) =>
        canAccessConversation({ principal, linkedOwnerUserId, thread, share, action }),
    };
  },
);

export function sharedConversationHttpRequestAllowed(method: string, path: string): boolean {
  if (method === "GET")
    return (
      path === "/api/auth/session" ||
      path === "/api/orchestration/shell" ||
      /^\/api\/orchestration\/threads\/[^/]+$/.test(path)
    );
  return method === "POST" && path === "/api/auth/websocket-ticket";
}

/** One live subscription per shared connection; each token/event check is an in-memory read. */
export const makeThreadAccessSession = Effect.fn("conversationSharing.makeThreadAccessSession")(
  function* (principal: AccessPrincipal, environmentId: EnvironmentId) {
    const linkedOwnerUserId = yield* readConversationOwnerUserId();
    const shareId = conversationShareIdFromSubject(principal.subject);
    const current = yield* Ref.make<ConversationShareSession | null>(null);
    const revoked = yield* Deferred.make<void>();
    if (shareId !== null) {
      const config = yield* resolveCloudSyncConfig;
      if (config._tag === "Configured") {
        const secrets = yield* ServerSecretStore;
        const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
        const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys });
        const ready = yield* Deferred.make<void>();
        const services = yield* Effect.context<never>();
        const runPromise = Effect.runPromiseWith(services);
        const runSync = Effect.runSyncWith(services);
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => new ConvexClient(config.settings.convexUrl)),
          (client) => Effect.promise(() => client.close()),
        );
        client.setAuth(() => runPromise(tokens.token).catch(() => null));
        let initialPermissions: string | null = null;
        const receive = (value: unknown) => {
          const decoded = decodeSession(value);
          const share =
            Option.isSome(decoded) &&
            decoded.value.environmentId === environmentId &&
            decoded.value.shareId === shareId
              ? decoded.value
              : null;
          runSync(Ref.set(current, share));
          runSync(Deferred.succeed(ready, undefined));
          if (share === null) runSync(Deferred.succeed(revoked, undefined));
          else {
            const permissions = JSON.stringify(
              share.conversations.toSorted((left, right) =>
                left.threadId.localeCompare(right.threadId),
              ),
            );
            if (initialPermissions === null) initialPermissions = permissions;
            else if (permissions !== initialPermissions)
              runSync(Deferred.succeed(revoked, undefined));
          }
        };
        const stop = client.onUpdate(sessionReference, { environmentId, shareId }, receive, () =>
          receive(null),
        );
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        yield* Deferred.await(ready).pipe(
          Effect.timeout("15 seconds"),
          Effect.catch(() => Effect.sync(() => receive(null))),
        );
      } else yield* Deferred.succeed(revoked, undefined);
    }
    const canAccess = (thread: AccessThread, action: ThreadAccessAction) =>
      Ref.get(current).pipe(
        Effect.map((share) =>
          canAccessConversation({ principal, linkedOwnerUserId, thread, share, action }),
        ),
      );
    const assertAccess = Effect.fn("conversationSharing.assertAccess")(function* (
      thread: AccessThread,
      action: ThreadAccessAction,
    ) {
      if (!(yield* canAccess(thread, action)))
        return yield* new EnvironmentAuthorizationError({
          requiredScope:
            action === "read" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
          message: "You do not have access to this conversation.",
        });
    });
    return {
      restricted: shareId !== null,
      share: Ref.get(current),
      revoked: Deferred.await(revoked),
      canAccess,
      assertAccess,
    };
  },
);
