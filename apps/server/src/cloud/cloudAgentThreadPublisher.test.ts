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
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import type { ConvexClientLike } from "./convexSyncTransport.ts";
import {
  AGENT_THREAD_UNBOUND_PARK_INTERVAL,
  cloudSafeThreadShell,
  isUnpublishableAgentThreadRefusal,
  makeCloudAgentThreadPublisher,
  runCloudAgentThreadPublisher,
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
  it.effect("publishes conversations only to their selected company", () =>
    Effect.gen(function* () {
      const { client, upserts } = fakeClient(() => Promise.resolve({ outcome: "published" }));
      const publisher = yield* makeCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://convex.example.test",
        tokens,
        client,
      });
      const conversation = {
        ...shellOf("conversation", "project-unused"),
        projectId: null,
        conversationCompanyId: COMPANY_ID,
        conversationPath: "/userdata/conversations/conversation",
        temporary: true,
      };
      yield* publisher.publish({
        ...conversation,
        conversationCompanyId: "another-company" as CompanyId,
      });
      yield* publisher.publish({ ...conversation, conversationCompanyId: null });
      expect(upserts).toEqual([]);
      yield* publisher.publish(conversation);
      expect(upserts).toEqual([{ threadId: "conversation", localProjectId: null }]);
    }),
  );
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

  it.effect("holds cosmetic-only live changes for reconcile but publishes state at once", () =>
    Effect.gen(function* () {
      const { client, upserts } = fakeClient(() => Promise.resolve({ outcome: "published" }));
      const publisher = yield* makeCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://example.convex.cloud",
        tokens,
        client,
      });
      const live = { deferCosmetic: true } as const;
      const shell = shellOf("thread-one", "project-one");
      const later = DateTime.add(NOW, { seconds: 5 });

      yield* publisher.publish(shell, live);
      yield* publisher.publish(
        { ...shell, itemCount: 4, visibleItemCount: 2, updatedAt: later },
        live,
      );
      assert.strictEqual(upserts.length, 1);

      yield* publisher.publish(
        { ...shell, status: "running", itemCount: 4, updatedAt: later },
        live,
      );
      assert.strictEqual(upserts.length, 2);

      yield* publisher.publish({ ...shell, status: "running", itemCount: 9, updatedAt: later });
      assert.strictEqual(upserts.length, 3);
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

it.effect("publishes a newly created thread while startup reconciliation is still blocked", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const scanning = yield* Deferred.make<void>();
    const finishScan = yield* Deferred.make<void>();
    const publishedNew = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const next = shellOf("new-during-reconcile", "project-one");
    const { client } = fakeClient((args) => {
      if (args["threadId"] === next.id) Deferred.doneUnsafe(publishedNew, Effect.void);
      return Promise.resolve({ outcome: "published" });
    });
    const service = {
      streamDomainEvents: Stream.unwrap(
        Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.fromQueue(events))),
      ),
      getShellSnapshot: () =>
        Deferred.succeed(scanning, undefined).pipe(
          Effect.andThen(Deferred.await(finishScan)),
          Effect.as({ threads: [], archivedThreads: [] }),
        ),
      getThreadShell: () => Effect.succeed(next),
    } as unknown as ThreadManagement.ThreadManagementService["Service"];
    const worker = yield* runCloudAgentThreadPublisher({
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      convexUrl: "https://convex.example.test",
      tokens,
      client,
    }).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, service),
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    yield* Deferred.await(scanning);
    yield* Queue.offer(events, {
      type: "thread.created",
      threadId: next.id,
    } as OrchestrationV2DomainEvent);
    yield* Deferred.await(publishedNew);
    expect(yield* Deferred.isDone(finishScan)).toBe(false);
    yield* Fiber.interrupt(worker);
  }),
);

for (const change of ["edited", "deleted"] as const) {
  it.effect(`does not restore a stale startup snapshot after a thread is ${change}`, () =>
    Effect.gen(function* () {
      const scanning = yield* Deferred.make<void>();
      const finishScan = yield* Deferred.make<void>();
      const livePublished = yield* Deferred.make<void>();
      const reconciled = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const stale = shellOf("changed-during-scan", "project-one", "Old title");
      const current = change === "deleted" ? null : { ...stale, title: "New title" };
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const client: ConvexClientLike = {
        setAuth: () => {},
        query: (() => Promise.reject(new Error("unexpected query"))) as ConvexClientLike["query"],
        mutation: ((reference: FunctionReference<"mutation">, args: Record<string, unknown>) => {
          const name = getFunctionName(reference);
          calls.push({ name, args });
          Deferred.doneUnsafe(
            name === "agentThreads:reconcile" ? reconciled : livePublished,
            Effect.void,
          );
          return Promise.resolve(name === "agentThreads:upsert" ? { outcome: "published" } : null);
        }) as ConvexClientLike["mutation"],
      };
      let firstSnapshot = true;
      const service = {
        streamDomainEvents: Stream.fromQueue(events),
        getShellSnapshot: () =>
          Effect.gen(function* () {
            if (firstSnapshot) {
              firstSnapshot = false;
              yield* Deferred.succeed(scanning, undefined);
              yield* Deferred.await(finishScan);
              return { threads: [stale], archivedThreads: [] };
            }
            return { threads: current ? [current] : [], archivedThreads: [] };
          }),
        getThreadShell: () => Effect.succeed(current),
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      const worker = yield* runCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://convex.example.test",
        tokens,
        client,
      }).pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, service),
        Effect.forkChild,
      );
      yield* Deferred.await(scanning);
      yield* Queue.offer(events, {
        type: change === "deleted" ? "thread.deleted" : "thread.metadata-updated",
        threadId: stale.id,
      } as OrchestrationV2DomainEvent);
      yield* Deferred.await(livePublished);
      yield* Deferred.succeed(finishScan, undefined);
      yield* Deferred.await(reconciled);
      const upserts = calls.filter((call) => call.name === "agentThreads:upsert");
      expect(upserts.map((call) => (call.args["shell"] as { title: string }).title)).toEqual(
        current ? ["New title"] : [],
      );
      expect(
        calls.find((call) => call.name === "agentThreads:reconcile")?.args["currentThreadIds"],
      ).toEqual(current ? [current.id] : []);
      yield* Fiber.interrupt(worker);
    }),
  );
}

describe("cloud Agent Thread publisher database reads", () => {
  /** A thread service over mutable shells that counts every projection read. */
  function countingService(initial: ReadonlyArray<OrchestrationV2ThreadShell>) {
    const shells = new Map(initial.map((shell) => [shell.id as string, shell]));
    const reads = { snapshots: 0, threadShells: [] as Array<string> };
    return Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const service = {
        streamDomainEvents: Stream.fromQueue(events),
        getShellSnapshot: () =>
          Effect.sync(() => {
            reads.snapshots += 1;
            return { threads: [...shells.values()], archivedThreads: [] };
          }),
        getThreadShell: (threadId: string) =>
          Effect.sync(() => {
            reads.threadShells.push(threadId);
            return shells.get(threadId) ?? null;
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      return { service, shells, reads, events } as const;
    });
  }

  /** Advances virtual time, then lets the fake client's promises settle in real time. */
  const advance = (duration: Parameters<typeof TestClock.adjust>[0]) =>
    Effect.gen(function* () {
      for (let round = 0; round < 3; round++) {
        yield* TestClock.adjust(round === 0 ? duration : "0 millis");
        yield* TestClock.withLive(Effect.sleep("5 millis"));
      }
    });

  const recordingClient = () => {
    const calls: Array<{ readonly name: string; readonly args: Record<string, unknown> }> = [];
    const client: ConvexClientLike = {
      setAuth: () => {},
      query: (() => Promise.reject(new Error("unexpected query"))) as ConvexClientLike["query"],
      mutation: ((reference: FunctionReference<"mutation">, args: Record<string, unknown>) => {
        const name = getFunctionName(reference);
        calls.push({ name, args });
        return Promise.resolve(name === "agentThreads:upsert" ? { outcome: "published" } : null);
      }) as ConvexClientLike["mutation"],
    };
    return { client, calls };
  };

  it.effect("stays off the database while idle and re-reads only touched threads", () =>
    Effect.gen(function* () {
      const first = shellOf("thread-one", "project-one");
      const second = shellOf("thread-two", "project-one");
      const { service, shells, reads, events } = yield* countingService([first, second]);
      const { client, calls } = recordingClient();
      const worker = yield* runCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://convex.example.test",
        tokens,
        client,
        reconcileInterval: "15 seconds",
        reconcileRepairInterval: "1 hour",
      }).pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, service),
        Effect.forkChild,
      );

      // Startup: one inventory snapshot, one re-read per unpublished shell, one confirming
      // snapshot for the first removal reconcile.
      yield* advance("1 second");
      expect(reads.snapshots).toBe(2);
      expect(reads.threadShells.toSorted()).toEqual(["thread-one", "thread-two"]);
      expect(calls.filter((call) => call.name === "agentThreads:upsert")).toHaveLength(2);

      // Idle ticks read nothing.
      yield* advance("5 minutes");
      expect(reads.snapshots).toBe(2);
      expect(reads.threadShells).toHaveLength(2);

      // Streaming activity is not published live, but the next tick re-reads that thread once.
      shells.set("thread-one", { ...first, itemCount: 7, visibleItemCount: 7 });
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        threadId: first.id,
        payload: { type: "agent_message" },
      } as unknown as OrchestrationV2DomainEvent);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        threadId: first.id,
        payload: { type: "agent_message" },
      } as unknown as OrchestrationV2DomainEvent);
      yield* advance("15 seconds");
      expect(reads.threadShells.slice(2)).toEqual(["thread-one"]);
      expect(calls.filter((call) => call.name === "agentThreads:upsert")).toHaveLength(3);

      // The hourly repair scan reads one snapshot and re-reads nothing that is already current.
      yield* advance("1 hour");
      expect(reads.threadShells).toHaveLength(3);
      expect(calls.filter((call) => call.name === "agentThreads:upsert")).toHaveLength(3);
      yield* Fiber.interrupt(worker);
    }),
  );

  it.effect("removes a conversation from the index as soon as it moves company", () =>
    Effect.gen(function* () {
      const conversation = {
        ...shellOf("conversation-one", "project-one"),
        projectId: null,
        conversationCompanyId: COMPANY_ID,
      } as OrchestrationV2ThreadShell;
      const { client, calls } = recordingClient();
      const publisher = yield* makeCloudAgentThreadPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://convex.example.test",
        tokens,
        client,
      });
      yield* publisher.publish(conversation);
      const moved = {
        ...conversation,
        conversationCompanyId: "0198f900-0000-7000-8000-000000000002",
      } as OrchestrationV2ThreadShell;
      expect(yield* publisher.isCurrent(moved)).toBe(false);
      yield* publisher.publish(moved);
      expect(calls.map((call) => call.name)).toEqual([
        "agentThreads:upsert",
        "agentThreads:remove",
      ]);
      expect(yield* publisher.isCurrent(moved)).toBe(true);
    }),
  );
});
