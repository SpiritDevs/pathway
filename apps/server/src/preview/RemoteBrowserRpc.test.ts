import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PreviewTabId,
  ThreadId,
  WS_METHODS,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { remoteBrowserRpcHandlers } from "./RemoteBrowserRpc.ts";
import { RemoteBrowser } from "./RemoteBrowser.ts";

const threadId = ThreadId.make("browser-rpc-authorization");

describe("remote browser RPC authorization", () => {
  it.effect("separates read-only interaction snapshots from control and clipboard RPCs", () =>
    Effect.gen(function* () {
      const browser = {
        subscribeSurface: () => Effect.void,
        command: () => Effect.succeed({ tabs: [], selectedTabId: null }),
        frames: () => Stream.empty,
        interact: vi.fn(() => Effect.die("must not execute")),
        interactions: vi.fn(() => Stream.empty),
      };
      const readOnly = remoteBrowserRpcHandlers([AuthOrchestrationReadScope], browser);
      const denied = yield* Effect.flip(
        readOnly[WS_METHODS.previewRemoteInteract]({
          action: "clipboardRead",
          threadId,
          tabId: PreviewTabId.make("tab"),
        }),
      );
      expect(denied).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
      expect(browser.interact).not.toHaveBeenCalled();
      yield* Stream.runDrain(readOnly[WS_METHODS.subscribePreviewRemoteInteractions]({ threadId }));
      expect(browser.interactions).toHaveBeenCalledOnce();
      const noScopes = remoteBrowserRpcHandlers([], browser);
      expect(
        (yield* Effect.flip(
          Stream.runDrain(noScopes[WS_METHODS.subscribePreviewRemoteInteractions]({ threadId })),
        ))._tag,
      ).toBe("EnvironmentAuthorizationError");
    }),
  );

  it.effect("keeps the hosted browser after leaving the service construction context", () =>
    Effect.gen(function* () {
      const browser = {
        interact: vi.fn(() => Effect.die("unused")),
        interactions: vi.fn(() => Stream.empty),
        subscribeSurface: vi.fn(() => Effect.void),
        command: vi.fn(() => Effect.succeed({ tabs: [], selectedTabId: null })),
        frames: vi.fn(() => Stream.empty),
      };
      const handlers = yield* Effect.gen(function* () {
        const hosted = yield* RemoteBrowser;
        return remoteBrowserRpcHandlers(
          [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          hosted,
        );
      }).pipe(Effect.provideService(RemoteBrowser, browser));
      yield* handlers[WS_METHODS.previewRemoteCommand]({
        action: "selectHost",
        host: "environment",
        threadId,
      });
      yield* Stream.runCollect(handlers[WS_METHODS.subscribePreviewRemoteFrames]({ threadId }));
      expect(browser.command).toHaveBeenCalledOnce();
      expect(browser.frames).toHaveBeenCalledOnce();
    }),
  );

  it.effect("denies browser commands to read-only tokens before invoking the browser", () =>
    Effect.gen(function* () {
      const browser = {
        interact: vi.fn(() => Effect.die("unused")),
        interactions: vi.fn(() => Stream.empty),
        subscribeSurface: vi.fn(() => Effect.void),
        command: vi.fn(() => Effect.succeed({ tabs: [], selectedTabId: null })),
        frames: vi.fn(() => Stream.empty),
      };
      const handlers = remoteBrowserRpcHandlers([AuthOrchestrationReadScope], browser);
      const failure = yield* Effect.flip(
        handlers[WS_METHODS.previewRemoteCommand]({ action: "open", threadId }),
      );
      expect(failure._tag).toBe("EnvironmentAuthorizationError");
      expect(failure).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
      expect(browser.command).not.toHaveBeenCalled();
    }),
  );

  it.effect("requires read scope before subscribing and forwards metadata-only subscriptions", () =>
    Effect.gen(function* () {
      const browser = {
        interact: vi.fn(() => Effect.die("unused")),
        interactions: vi.fn(() => Stream.empty),
        subscribeSurface: vi.fn(() => Effect.void),
        command: vi.fn(() => Effect.succeed({ tabs: [], selectedTabId: null })),
        frames: vi.fn(() => Stream.empty),
      };
      const denied = remoteBrowserRpcHandlers([], browser);
      const failure = yield* Effect.flip(
        Stream.runCollect(denied[WS_METHODS.subscribePreviewRemoteFrames]({ threadId })),
      );
      expect(failure._tag).toBe("EnvironmentAuthorizationError");
      expect(failure).toMatchObject({ requiredScope: AuthOrchestrationReadScope });
      expect(browser.frames).not.toHaveBeenCalled();
      const allowed = remoteBrowserRpcHandlers([AuthOrchestrationReadScope], browser);
      yield* Stream.runCollect(allowed[WS_METHODS.subscribePreviewRemoteFrames]({ threadId }));
      expect(browser.frames).toHaveBeenCalledWith({ threadId });
    }),
  );

  it.effect("executes authorized autofill with tracing disabled", () =>
    Effect.gen(function* () {
      let tracingEnabled: boolean | undefined;
      const browser = {
        interact: vi.fn(() => Effect.die("unused")),
        interactions: vi.fn(() => Stream.empty),
        subscribeSurface: vi.fn(() => Effect.void),
        command: vi.fn(() =>
          Effect.gen(function* () {
            tracingEnabled = yield* References.TracerEnabled;
            return { tabs: [], selectedTabId: null };
          }),
        ),
        frames: () => Stream.empty,
      };
      const handlers = remoteBrowserRpcHandlers([AuthOrchestrationOperateScope], browser);
      yield* handlers[WS_METHODS.previewRemoteCommand]({
        action: "autofill",
        threadId,
        tabId: PreviewTabId.make("remote-example"),
        origin: "https://example.com",
        username: "test-user",
        password: "test-password",
      });
      expect(browser.command).toHaveBeenCalledOnce();
      expect(tracingEnabled).toBe(false);
    }),
  );
});
