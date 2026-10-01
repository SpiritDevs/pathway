import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  PreviewAutomationConnectionId,
  ThreadId,
  type PreviewRemoteInteractionCommand,
  type PreviewRemoteInteractionEvent,
  type PreviewRemoteInteractionState,
  PreviewTabId,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { makeRemoteBrowser } from "./RemoteBrowser.ts";
import type { BrowserArtifact } from "./RemoteBrowserRuntime.ts";

const threadId = ThreadId.make("remote-deleted-task");
const makeHarness = Effect.fn(function* () {
  let deleted = false;
  let agentRunning = false;
  const deletions = yield* Queue.unbounded<ThreadId>();
  const requests = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
  const responses = yield* Queue.unbounded<PreviewAutomationResponse>();
  const closed = Promise.withResolvers<void>();
  const subscribed = Promise.withResolvers<void>();
  const unsubscribe = vi.fn(async () => undefined);
  const runtime = {
    interact: vi.fn(
      async (
        _input: PreviewRemoteInteractionCommand,
        authorize: () => Promise<void>,
      ): Promise<PreviewRemoteInteractionState> => {
        await authorize();
        return {
          tabId: PreviewTabId.make("tab"),
          cursor: "default",
          clipboard: null,
          dialog: null,
          select: null,
          fileChooser: null,
          downloads: [],
        };
      },
    ),
    subscribeInteractions: vi.fn(
      async (_threadId: string, _listener: (event: PreviewRemoteInteractionEvent) => void) =>
        async () =>
          undefined,
    ),
    subscribeSurface: vi.fn(async () => async () => undefined),
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
  const signArtifact = vi.fn((artifact: BrowserArtifact) =>
    Effect.succeed({ ...artifact, url: "test-capture" }),
  );
  const service = yield* makeRemoteBrowser({
    runtime,
    broker,
    environmentId: EnvironmentId.make("test-environment"),
    getThreadProjection: () =>
      Effect.sync(() => ({
        thread: { deletedAt: deleted ? DateTime.makeUnsafe("2026-09-07T00:00:00Z") : null },
        runs: agentRunning ? [{ status: "running" as const }] : [],
      })),
    deletedThreads: Stream.fromQueue(deletions),
    signArtifact,
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
    signArtifact,
    markAgentRunning: () => {
      agentRunning = true;
    },
    markDeleted: () => {
      deleted = true;
    },
  };
});

describe("remote browser deleted task lifecycle", () => {
  it.effect(
    "denies interaction control while an agent runs, including the last-moment recheck",
    () =>
      Effect.gen(function* () {
        const input = {
          action: "clipboardRead" as const,
          threadId,
          tabId: PreviewTabId.make("tab"),
        };
        const h = yield* makeHarness();
        h.markAgentRunning();
        expect((yield* Effect.flip(h.service.interact(input))).detail).toContain(
          "Take browser control",
        );
        expect(h.runtime.interact).not.toHaveBeenCalled();
        const racing = yield* makeHarness();
        racing.runtime.interact.mockImplementation(async (_input, authorize) => {
          racing.markAgentRunning();
          await authorize();
          throw new Error("must not apply");
        });
        expect((yield* Effect.flip(racing.service.interact(input))).detail).toContain(
          "Take browser control",
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "acknowledges interactions without snapshots and reuses subscription download signatures",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const state: PreviewRemoteInteractionState = {
          tabId: PreviewTabId.make("tab"),
          cursor: "default",
          clipboard: null,
          dialog: null,
          fileChooser: null,
          select: null,
          downloads: [
            {
              downloadId: "download",
              name: "report.csv",
              status: "ready",
              attachmentId: "attachment",
              sizeBytes: 4,
            },
          ],
        };
        const delivered = yield* Queue.unbounded<PreviewRemoteInteractionEvent>();
        const unsubscribed = vi.fn(async () => undefined);
        let publish = (_event: PreviewRemoteInteractionEvent) => {};
        h.runtime.subscribeInteractions.mockImplementation(async (_thread, listener) => {
          publish = listener;
          listener({ type: "state", tabs: [state] });
          return unsubscribed;
        });
        const running = yield* h.service.interactions({ threadId }).pipe(
          Stream.runForEach((event) => Queue.offer(delivered, event)),
          Effect.flip,
          Effect.forkScoped,
        );
        expect((yield* Queue.take(delivered)).tabs[0]?.downloads[0]?.url).toBe("test-capture");
        h.runtime.interact.mockResolvedValue(state);
        for (const command of [
          { action: "pointerMove", x: 1, y: 2 },
          { action: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 1 },
          {
            action: "composition",
            phase: "update",
            text: "test",
            selectionStart: 0,
            selectionEnd: 4,
          },
          { action: "clipboardRead" },
        ] as const) {
          expect(
            yield* h.service.interact({ ...command, threadId, tabId: state.tabId }),
          ).toBeUndefined();
          publish({ type: "state", tabs: [{ ...state, clipboard: "copied" }] });
          const event = yield* Queue.take(delivered);
          expect(event.tabs[0]?.clipboard).toBe("copied");
          expect(event.tabs[0]?.downloads[0]?.url).toBe("test-capture");
        }
        expect(h.signArtifact).toHaveBeenCalledOnce();
        h.markDeleted();
        yield* Queue.offer(h.deletions, threadId);
        expect((yield* Fiber.join(running)).detail).toContain("unavailable");
        expect(unsubscribed).toHaveBeenCalledOnce();
      }).pipe(Effect.scoped),
  );

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
