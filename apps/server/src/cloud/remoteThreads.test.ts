import { it } from "@effect/vitest";
import {
  AuthPeerReadUnsupportedCode,
  MessageId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@spiritdevs/contracts";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { grantFailureMessage, planRemoteSend } from "./remoteThreads.ts";

const threadId = ThreadId.make("thread-elsewhere");

describe("grantFailureMessage", () => {
  it("asks for an update when the thread's environment cannot limit remote reads", () => {
    expect(
      grantFailureMessage(
        threadId,
        new ConvexError({ code: AuthPeerReadUnsupportedCode, message: "update" }),
      ),
    ).toMatch(/older Pathway that cannot limit remote reads/u);
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
