import { assert, describe, expect, it } from "@effect/vitest";
import {
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { type FunctionReference, getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import type { ConvexClientLike } from "./convexSyncTransport.ts";
import {
  AGENT_THREAD_UNBOUND_PARK_INTERVAL,
  cloudSafeThreadShell,
  isUnpublishableAgentThreadRefusal,
  makeCloudAgentThreadPublisher,
  shouldPublishCloudAgentThreadEvent,
} from "./cloudAgentThreadPublisher.ts";

const COMPANY_ID = "0198f900-0000-7000-8000-000000000001" as CompanyId;
const ENVIRONMENT_ID = "environment-one" as EnvironmentId;
const NOW = DateTime.makeUnsafe("2026-09-02T00:00:00.000Z");
const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);

function shellOf(id: string, projectId: string, title = "Title"): OrchestrationV2ThreadShell {
  return decodeThreadShell({
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    settleAfterCompletion: false,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });
}

/** A fake Convex client whose upsert answer is supplied by the test; other calls succeed. */
function fakeClient(answer: (args: Record<string, unknown>) => Promise<unknown>) {
  const upserts: Array<{ readonly threadId: unknown; readonly localProjectId: unknown }> = [];
  const client: ConvexClientLike = {
    setAuth: () => {},
    query: (() => Promise.reject(new Error("unexpected query"))) as ConvexClientLike["query"],
    mutation: ((reference: FunctionReference<"mutation">, args: Record<string, unknown>) => {
      if (getFunctionName(reference) !== "agentThreads:upsert") return Promise.resolve(null);
      upserts.push({ threadId: args["threadId"], localProjectId: args["localProjectId"] });
      return answer(args);
    }) as ConvexClientLike["mutation"],
  };
  return { client, upserts };
}

const tokens: ConvexServiceTokenProvider = {
  token: Effect.succeed("service-token"),
  invalidate: () => Effect.void,
};

describe("cloud Agent Thread publisher", () => {
  it("removes message text while retaining discovery metadata", () => {
    const shell = {
      id: "thread-one",
      projectId: "project-one",
      title: "Visible title",
      settleAfterCompletion: false,
      latestVisibleMessage: {
        id: "message-one",
        role: "assistant",
        text: "private transcript content",
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
    } as unknown as OrchestrationV2ThreadShell;

    expect(cloudSafeThreadShell(shell)).toMatchObject({
      id: "thread-one",
      projectId: "project-one",
      title: "Visible title",
      settleAfterCompletion: false,
      latestVisibleMessage: {
        id: "message-one",
        role: "assistant",
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
    });
    expect(cloudSafeThreadShell(shell).latestVisibleMessage).not.toHaveProperty("text");
  });

  it("waits for the final message update instead of publishing every streamed token", () => {
    const event = (streaming: boolean) =>
      ({ type: "message.updated", payload: { streaming } }) as OrchestrationV2DomainEvent;

    expect(shouldPublishCloudAgentThreadEvent(event(true))).toBe(false);
    expect(shouldPublishCloudAgentThreadEvent(event(false))).toBe(true);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as OrchestrationV2DomainEvent),
    ).toBe(false);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "turn-item.updated",
        payload: { type: "source_control", pullRequestAction: "attached" },
      } as OrchestrationV2DomainEvent),
    ).toBe(true);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "turn-item.updated",
        payload: { type: "source_control", pullRequestAction: "detached" },
      } as OrchestrationV2DomainEvent),
    ).toBe(true);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "turn-item.updated",
        payload: { type: "source_control" },
      } as OrchestrationV2DomainEvent),
    ).toBe(false);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "thread.metadata-updated",
      } as OrchestrationV2DomainEvent),
    ).toBe(true);
  });

  it("parks only the typed binding refusal, never transport or auth failures", () => {
    expect(
      isUnpublishableAgentThreadRefusal(
        new ConvexError({
          code: "entity-not-found",
          message: "The Agent Thread project has no active binding on this environment.",
        }),
      ),
    ).toBe(true);
    expect(
      isUnpublishableAgentThreadRefusal(
        new ConvexError({ code: "permission-denied", message: "Missing permission." }),
      ),
    ).toBe(false);
    expect(
      isUnpublishableAgentThreadRefusal(
        new ConvexError({ code: "entity-not-found", message: "The Agent Thread vanished." }),
      ),
    ).toBe(false);
    expect(isUnpublishableAgentThreadRefusal(new ConvexError("plain payload"))).toBe(false);
    expect(isUnpublishableAgentThreadRefusal(new Error("fetch failed"))).toBe(false);
    expect(isUnpublishableAgentThreadRefusal(undefined)).toBe(false);
  });

  it.effect("parks only the refused thread while indexed siblings keep updating", () =>
    Effect.gen(function* () {
      const unboundThreads = new Set(["thread-new"]);
      const { client, upserts } = fakeClient((args) =>
        Promise.resolve({
          outcome: unboundThreads.has(String(args["threadId"])) ? "unbound" : "published",
        }),
      );
      const publisher = yield* makeCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://example.convex.cloud",
        tokens,
        client,
      });

      yield* publisher.publish(shellOf("thread-new", "project-unbound"));
      // Shell edits do not bypass the refused thread's park.
      yield* publisher.publish(shellOf("thread-new", "project-unbound", "Renamed"));
      assert.strictEqual(upserts.length, 1);

      // An already-indexed sibling remains publishable after the binding is revoked.
      yield* publisher.publish(shellOf("thread-indexed", "project-unbound"));
      yield* publisher.publish(shellOf("thread-indexed", "project-unbound", "Updated"));
      assert.deepEqual(upserts.slice(1), [
        { threadId: "thread-indexed", localProjectId: "project-unbound" },
        { threadId: "thread-indexed", localProjectId: "project-unbound" },
      ]);

      // Once the park expires only the refused thread is probed again.
      yield* TestClock.adjust(AGENT_THREAD_UNBOUND_PARK_INTERVAL);
      yield* publisher.publish(shellOf("thread-new", "project-unbound"));
      assert.deepEqual(upserts.at(-1), {
        threadId: "thread-new",
        localProjectId: "project-unbound",
      });
      assert.strictEqual(upserts.length, 4);

      // A successful probe after assignment lifts this thread's park.
      yield* TestClock.adjust(AGENT_THREAD_UNBOUND_PARK_INTERVAL);
      unboundThreads.clear();
      yield* publisher.publish(shellOf("thread-new", "project-unbound"));
      // An unchanged published shell is not resent.
      yield* publisher.publish(shellOf("thread-new", "project-unbound"));
      assert.strictEqual(upserts.length, 5);
    }),
  );

  it.effect("treats a legacy thrown binding refusal exactly like the unbound outcome", () =>
    Effect.gen(function* () {
      const { client, upserts } = fakeClient(() =>
        Promise.reject(
          new ConvexError({
            code: "entity-not-found",
            message: "The Agent Thread project has no active binding on this environment.",
          }),
        ),
      );
      const publisher = yield* makeCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://example.convex.cloud",
        tokens,
        client,
      });

      yield* publisher.publish(shellOf("thread-one", "project-unbound"));
      yield* publisher.publish(shellOf("thread-one", "project-unbound", "Renamed"));
      yield* publisher.publish(shellOf("thread-two", "project-unbound"));
      assert.strictEqual(upserts.length, 2);
    }),
  );

  it.effect("accepts a legacy successful upsert with no outcome", () =>
    Effect.gen(function* () {
      const { client, upserts } = fakeClient(() => Promise.resolve(null));
      const publisher = yield* makeCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://example.convex.cloud",
        tokens,
        client,
      });

      yield* publisher.publish(shellOf("thread-one", "project-bound"));
      yield* publisher.publish(shellOf("thread-one", "project-bound"));
      assert.strictEqual(upserts.length, 1);
    }),
  );

  it.effect("keeps transport failures retryable instead of parking the thread", () =>
    Effect.gen(function* () {
      const { client, upserts } = fakeClient(() => Promise.reject(new Error("fetch failed")));
      const publisher = yield* makeCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://example.convex.cloud",
        tokens,
        client,
      });

      const first = yield* Effect.exit(publisher.publish(shellOf("thread-one", "project-one")));
      const second = yield* Effect.exit(publisher.publish(shellOf("thread-two", "project-one")));
      assert.strictEqual(first._tag, "Failure");
      assert.strictEqual(second._tag, "Failure");
      assert.strictEqual(upserts.length, 2);
    }),
  );
});
