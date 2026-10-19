import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  PreviewAutomationConnectionId,
  ThreadId,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { makeRemoteBrowser } from "./RemoteBrowser.ts";

const threadId = ThreadId.make("remote-deleted-task");
const makeHarness = Effect.fn(function* () {
  let deleted = false;
  const deletions = yield* Queue.unbounded<ThreadId>();
  const requests = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
  const responses = yield* Queue.unbounded<PreviewAutomationResponse>();
  const closed = Promise.withResolvers<void>();
  const subscribed = Promise.withResolvers<void>();
  const unsubscribe = vi.fn(async () => undefined);
  const runtime = {
    command: vi.fn(async (_input: unknown, beforeAction?: () => Promise<void>) => {
      await beforeAction?.();
      return { tabs: [], selectedTabId: null, artifacts: [] };
    }),
    automate: vi.fn(async () => ({})),
    subscribe: vi.fn(async () => {
      subscribed.resolve();
      return unsubscribe;
    }),
    closeThread: vi.fn(async (_threadId: string) => {
      closed.resolve();
    }),
  };
  const broker = {
    connect: () => Effect.succeed(Stream.fromQueue(requests)),
    focusHost: () => Effect.void,
    selectHostForThread: vi.fn(() => Effect.void),
    getSelectedHostForThread: () => Effect.succeed(null),
    respond: (response: PreviewAutomationResponse) =>
      Queue.offer(responses, response).pipe(Effect.asVoid),
    invoke: <A>() => Effect.die("Unexpected invocation") as Effect.Effect<A>,
  };
  const service = yield* makeRemoteBrowser({
    runtime,
    broker,
    environmentId: EnvironmentId.make("test-environment"),
    getThreadProjection: () =>
      Effect.sync(() => ({
        thread: { deletedAt: deleted ? DateTime.makeUnsafe("2026-09-07T00:00:00Z") : null },
        runs: [],
      })),
    deletedThreads: Stream.fromQueue(deletions),
    signArtifact: (artifact) => Effect.succeed({ ...artifact, url: "test-capture" }),
  });
  return {
    service,
    runtime,
    broker,
    deletions,
    requests,
    responses,
    closed,
    subscribed,
    unsubscribe,
    markDeleted: () => {
      deleted = true;
    },
  };
});

describe("remote browser deleted task lifecycle", () => {
  it.effect(
    "rejects deleted tasks before commands, host selection, metadata or frame subscriptions",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.markDeleted();
        for (const input of [
          { action: "list", threadId },
          { action: "open", threadId },
          { action: "selectHost", threadId, host: "environment" },
        ] as const) {
          expect((yield* Effect.flip(h.service.command(input))).detail).toContain("unavailable");
        }
        for (const tabId of [undefined, "remote-tab"]) {
          expect(
            (yield* Effect.flip(Stream.runDrain(h.service.frames({ threadId, tabId })))).detail,
          ).toContain("unavailable");
        }
        expect(h.runtime.command).not.toHaveBeenCalled();
        expect(h.runtime.subscribe).not.toHaveBeenCalled();
        expect(h.broker.selectHostForThread).not.toHaveBeenCalled();
      }).pipe(Effect.scoped),
  );

  it.effect("rejects broker automation for a deleted task with a correlated error response", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.markDeleted();
      yield* Queue.offer(h.requests, {
        type: "request",
        connectionId: PreviewAutomationConnectionId.make("test-connection"),
        request: {
          requestId: "deleted-request",
          threadId,
          operation: "status",
          input: {},
          timeoutMs: 1000,
        },
      });
      const response = yield* Queue.take(h.responses);
      expect(response).toMatchObject({
        requestId: "deleted-request",
        ok: false,
        error: { _tag: "PreviewRemoteError" },
      });
      expect(h.runtime.automate).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect("durable deletion closes idle contexts and terminates active frame streams", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const stream = yield* Stream.runDrain(h.service.frames({ threadId })).pipe(
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Effect.promise(() => h.subscribed.promise);
      h.markDeleted();
      yield* Queue.offer(h.deletions, threadId);
      expect((yield* Fiber.join(stream)).detail).toContain("unavailable");
      yield* Effect.promise(() => h.closed.promise);
      expect(h.runtime.closeThread).toHaveBeenCalledWith(threadId);
      expect(h.unsubscribe).toHaveBeenCalledOnce();
      const idleId = ThreadId.make("idle-task");
      const idleClosed = Promise.withResolvers<void>();
      h.runtime.closeThread.mockImplementation(async (id) => {
        if (id === idleId) idleClosed.resolve();
      });
      yield* Queue.offer(h.deletions, idleId);
      yield* Effect.promise(() => idleClosed.promise);
      expect(h.runtime.closeThread).toHaveBeenCalledWith(idleId);
    }).pipe(Effect.scoped),
  );

  it.effect("rechecks deletion when a queued command reaches the browser", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.runtime.command.mockImplementationOnce(async (_input, beforeAction) => {
        h.markDeleted();
        await beforeAction?.();
        return { tabs: [], selectedTabId: null, artifacts: [] };
      });
      expect(
        (yield* Effect.flip(h.service.command({ action: "open", threadId }))).detail,
      ).toContain("unavailable");
      expect(h.runtime.closeThread).toHaveBeenCalledWith(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "closes a subscription opened while deletion commits even before the event is consumed",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.runtime.subscribe.mockImplementationOnce(async () => {
          h.markDeleted();
          return h.unsubscribe;
        });
        expect(
          (yield* Effect.flip(Stream.runDrain(h.service.frames({ threadId })))).detail,
        ).toContain("unavailable");
        expect(h.runtime.closeThread).toHaveBeenCalledWith(threadId);
        expect(h.unsubscribe).toHaveBeenCalledOnce();
      }).pipe(Effect.scoped),
  );
});
