import { it } from "@effect/vitest";
import {
  AuthPeerReadScopes,
  AuthPeerSendScopes,
  AuthPeerThreadAccessUnsupportedCode,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@spiritdevs/contracts";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import { grantFailureMessage, planRemoteSend, sendOnTarget } from "./remoteThreads.ts";

const threadId = ThreadId.make("thread-elsewhere");

describe("grantFailureMessage", () => {
  it("asks for an update when the thread's environment cannot limit remote thread access", () => {
    expect(
      grantFailureMessage(
        threadId,
        new ConvexError({ code: AuthPeerThreadAccessUnsupportedCode, message: "update" }),
      ),
    ).toMatch(/older Pathway that cannot limit remote thread access/u);
  });

  it("fails closed with a generic message for other refusals and older Pathway Cloud", () => {
    for (const cause of [
      new ConvexError({ code: "permission-denied", message: "no" }),
      new Error("Could not find public function for 'connectGrants:issueThreadAccess'"),
    ]) {
      expect(grantFailureMessage(threadId, cause)).toBe(
        `Pathway could not reach thread ${threadId} on its environment.`,
      );
    }
  });
});

const projection = (overrides: {
  readonly deletedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly messageIds?: ReadonlyArray<string>;
}) =>
  ({
    thread: {
      id: threadId,
      deletedAt: overrides.deletedAt ?? null,
      archivedAt: overrides.archivedAt ?? null,
    },
    messages: (overrides.messageIds ?? []).map((id) => ({ id })),
    runs: [],
    providerTurns: [],
  }) as unknown as OrchestrationV2ThreadProjection;

describe("planRemoteSend", () => {
  const messageId = MessageId.make("message-1");

  it.effect("treats a deleted thread as missing so nothing is dispatched", () =>
    Effect.gen(function* () {
      const plan = yield* planRemoteSend(
        projection({ deletedAt: "2026-09-29T00:00:00.000Z" }),
        messageId,
        "auto",
      );
      expect(plan._tag).toBe("Missing");
    }),
  );

  it.effect(
    "reports an earlier send whose reply was lost instead of re-checking steerability",
    () =>
      Effect.gen(function* () {
        const plan = yield* planRemoteSend(
          projection({ messageIds: [messageId] }),
          messageId,
          "steer",
        );
        expect(plan._tag).toBe("AlreadySent");
      }),
  );

  it.effect("dispatches new messages with the shared dispatch mode rules", () =>
    Effect.gen(function* () {
      const plan = yield* planRemoteSend(projection({}), messageId, "auto");
      expect(plan).toEqual({ _tag: "Dispatch", dispatchMode: { type: "start_immediately" } });
      const steer = yield* planRemoteSend(projection({}), messageId, "steer").pipe(Effect.flip);
      expect(steer._tag).toBe("ThreadManagementNoSteerableRunError");
      const archived = yield* planRemoteSend(
        projection({ archivedAt: "2026-09-29T00:00:00.000Z" }),
        messageId,
        "auto",
      ).pipe(Effect.flip);
      expect(archived._tag).toBe("ThreadManagementThreadArchivedError");
    }),
  );
});

describe("sendOnTarget", () => {
  const messageId = MessageId.make("message-1");
  const landed = {
    thread: { id: threadId, deletedAt: null, archivedAt: null },
    messages: [{ id: messageId, runId: "run-1" }],
    runs: [{ id: "run-1", status: "completed" }],
    turnItems: [{ type: "user_message", messageId, inputIntent: "turn_start" }],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;

  const fakeClient = (projections: ReadonlyArray<OrchestrationV2ThreadProjection>) => {
    const dispatched: Array<unknown> = [];
    let reads = 0;
    const client = {
      [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () =>
        Effect.sync(() => projections[Math.min(reads++, projections.length - 1)]!),
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: unknown) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1 };
        }),
    } as unknown as Parameters<typeof sendOnTarget>[0];
    return { client, dispatched };
  };
  const input = (authorize: () => Effect.Effect<void, string>) => ({
    threadId,
    commandId: CommandId.make("command-1"),
    messageId,
    text: "Kick off",
    mode: "auto" as const,
    authorize,
  });
  const environmentId = EnvironmentId.make("env-target");

  it.effect("reports a landed message on retry without re-authorizing or re-dispatching", () =>
    Effect.gen(function* () {
      const { client, dispatched } = fakeClient([landed]);
      // The target's modes changed since the original send; a retry must still report success.
      const result = yield* sendOnTarget(
        client,
        environmentId,
        input(() => Effect.fail("runtime_mode_escalation_denied")),
      );
      expect(result).toMatchObject({ environmentId, delivery: "started" });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("authorizes before dispatching a new message", () =>
    Effect.gen(function* () {
      const { client, dispatched } = fakeClient([projection({})]);
      const denied = yield* sendOnTarget(
        client,
        environmentId,
        input(() => Effect.fail("runtime_mode_escalation_denied")),
      ).pipe(Effect.flip);
      expect(denied).toBe("runtime_mode_escalation_denied");
      expect(dispatched).toEqual([]);

      const allowed = fakeClient([projection({}), landed]);
      const result = yield* sendOnTarget(
        allowed.client,
        environmentId,
        input(() => Effect.void),
      );
      expect(result?.delivery).toBe("started");
      expect(allowed.dispatched).toMatchObject([
        { type: "message.dispatch", messageId, createdBy: "agent", creationSource: "mcp" },
      ]);
    }),
  );

  it.effect("never dispatches to a deleted thread", () =>
    Effect.gen(function* () {
      const { client, dispatched } = fakeClient([
        projection({ deletedAt: "2026-09-29T00:00:00.000Z" }),
      ]);
      const result = yield* sendOnTarget(
        client,
        environmentId,
        input(() => Effect.void),
      );
      expect(result).toBeNull();
      expect(dispatched).toEqual([]);
    }),
  );
});

describe("thread session scopes", () => {
  const allowed = (scopes: ReadonlyArray<string>, method: keyof typeof RPC_REQUIRED_SCOPES) =>
    scopes.includes(RPC_REQUIRED_SCOPES[method]);

  it("let read sessions read threads but not dispatch", () => {
    expect(allowed(AuthPeerReadScopes, ORCHESTRATION_V2_WS_METHODS.getThreadProjection)).toBe(true);
    expect(allowed(AuthPeerReadScopes, ORCHESTRATION_V2_WS_METHODS.dispatchCommand)).toBe(false);
  });

  it("let send sessions read and dispatch but nothing broader", () => {
    expect(allowed(AuthPeerSendScopes, ORCHESTRATION_V2_WS_METHODS.getThreadProjection)).toBe(true);
    expect(allowed(AuthPeerSendScopes, ORCHESTRATION_V2_WS_METHODS.dispatchCommand)).toBe(true);
    // Terminal and review RPCs exist and are all out of reach.
    const excluded = Object.entries(RPC_REQUIRED_SCOPES).filter(
      ([, scope]) => scope === AuthTerminalOperateScope || scope === AuthReviewWriteScope,
    );
    expect(excluded.length).toBeGreaterThan(0);
    for (const [method] of excluded)
      expect(allowed(AuthPeerSendScopes, method as keyof typeof RPC_REQUIRED_SCOPES)).toBe(false);
  });
});
