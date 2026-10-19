import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind } from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  makeComputerTools,
  type ComputerToolsOptions,
} from "../mcp/toolkits/computer/computerTools.ts";
import { ComputerToolError, type ToolContext } from "../mcp/toolkits/computer/toolRuntime.ts";
import type { ComputerApprovalOutcome } from "./ComputerApprovalGate.ts";
import type { ComputerBackend } from "./ComputerBackend.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

const PATHWAY_PROVIDERS = ["codex", "claudeAgent", "cursor", "grok", "opencode"] as const;

function context(): ToolContext {
  return {
    callerThreadId: "audit",
    callerThreadLabel: "Audit",
    callerSessionKey: "audit",
    callerProvider: ProviderDriverKind.make("claudeAgent"),
    callerCapabilities: new Set(["computer"]),
    callerTurnId: "turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

const setupTools = Effect.fn(function* (
  backend: FakeComputerBackend = new FakeComputerBackend(),
  authorizeAction?: ComputerToolsOptions["authorizeAction"],
) {
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  const tools = new Map(
    makeComputerTools({ manager, ...(authorizeAction ? { authorizeAction } : {}) }).map(
      (tool) => [tool.definition.name, tool] as const,
    ),
  );
  const call = (name: string, args: Record<string, unknown> = {}, caller = context()) =>
    tools.get(name)!.handler(args, caller);
  return { manager, backend, call };
});

it.layer(NodeServices.layer)("Production audit: desired invariants", (it) => {
  it.effect("hover must not change keyboard focus", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.moveCursor("audit", { windowId: "fake-calculator", x: 1180, y: 228 });
        expect(backend.calls.filter((c) => c.method === "focusWindow")).toEqual([]);
      }),
    ),
  );

  it.effect("concurrent keyboard calls must preserve each named target", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const backend = new FakeComputerBackend();
      let aim = "";
      const deliveries: { text: string; aim: string }[] = [];
      Object.assign(backend, {
        focusWindow: (id: string) =>
          Effect.gen(function* () {
            aim = id;
            if (id === "fake-calculator") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
          }),
        typeText: (text: string) =>
          Effect.sync(() => {
            deliveries.push({ text, aim });
            return { value: text };
          }),
      } satisfies Partial<ComputerBackend>);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.listWindows();
          const first = yield* Effect.forkChild(
            manager.typeText("audit", "calculator text", "fake-calculator"),
          );
          yield* Deferred.await(entered);
          const second = yield* Effect.forkChild(
            manager.typeText("audit", "browser text", "fake-terminal"),
            { startImmediately: true },
          );
          yield* Effect.yieldNow;
          expect(deliveries).toEqual([]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      );
      expect(deliveries.find((d) => d.text === "calculator text")?.aim).toBe("fake-calculator");
    }),
  );

  // The gateway tool is a thin wrapper over `manager.click`; an aborted tool
  // call is an interrupted fiber here, so the invariant is proved on the
  // manager call the tool would have made.
  it.effect("aborting a tool during targeting must prevent its later click", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const backend = new FakeComputerBackend();
      const getState = backend.getState.bind(backend);
      Object.assign(backend, {
        getState: (options: Parameters<ComputerBackend["getState"]>[0]) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* getState(options);
          }),
      } satisfies Partial<ComputerBackend>);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const result = yield* Effect.forkChild(
            manager.click("audit", { label: "Calculate", role: "button" }),
          );
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(result);
          yield* Deferred.succeed(release, undefined);
          yield* Effect.yieldNow;
        }),
      );
      expect(backend.calls.filter((c) => c.method === "click")).toEqual([]);
    }),
  );

  it.effect("an intervening explicit screenshot must prevent unrelated image reuse", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setupTools();
        yield* call("computer_click", { label: "Calculate", role: "button" });
        const explicit = yield* call("computer_screenshot", { window_id: "fake-terminal" });
        expect(explicit.isError).not.toBe(true);
        expect(explicit.content.some((c) => c.type === "image")).toBe(true);
        const result = yield* call("computer_click", { label: "Calculate", role: "button" });
        expect(result.content.some((c) => c.type === "image")).toBe(true);
      }),
    ),
  );

  it.effect("a moved window must deliver its new screenshot geometry", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend();
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.captureActionScreenshot("fake-calculator", undefined, "audit");
          backend.emitWindowsChanged(
            (yield* backend.listWindows()).map((w) =>
              w.id === "fake-calculator" ? { ...w, bounds: { ...w.bounds!, x: 800 } } : w,
            ),
          );
          return yield* manager.captureActionScreenshot("fake-calculator", undefined, "audit");
        }),
      );
      expect(result).toHaveProperty("screenshot.region.x", 800);
    }),
  );
});

it.layer(NodeServices.layer)("Provider authority invariants", (it) => {
  it.effect("a fresh invocation re-arms Stop but an older queued invocation cannot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ComputerManager.make({
          backend: new FakeComputerBackend(),
          actionSettleMs: 0,
        });
        const stopped = yield* manager.setControlEnabled("audit", false);
        expect((yield* manager.getThreadState("audit")).controlGeneration).toBe(stopped.generation);
        expect(yield* manager.admitControl("audit", "request", 0, true)).toBe(false);
        expect(yield* manager.admitControl("audit", "request", stopped.generation, true)).toBe(
          true,
        );
        // Re-arming this explicit request never authorizes later turns or goals.
        expect(manager.canContinueChatControl("audit")).toBe(false);
      }),
    ),
  );

  it.effect("routes every provider's routine mutations through the same task gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const authorizeAction = vi.fn((_name: string) =>
          Effect.succeed<ComputerApprovalOutcome>("approved"),
        );
        const { call } = yield* setupTools(new FakeComputerBackend(), authorizeAction);
        for (const provider of PATHWAY_PROVIDERS) {
          // A distinct text per provider keeps every call's repeat-guard key
          // distinct — the guard would refuse a third identical unverified
          // send before the approval gate this test measures.
          yield* call(
            "computer_type_text",
            { text: `check-${provider}`, window_id: "fake-terminal", include_screenshot: false },
            { ...context(), callerProvider: ProviderDriverKind.make(provider) },
          );
          expect(authorizeAction.mock.calls.at(-1)?.[0]).toBe("computer_type_text");
        }
        expect(authorizeAction).toHaveBeenCalledTimes(PATHWAY_PROVIDERS.length);
      }),
    ),
  );

  it.effect.each(PATHWAY_PROVIDERS)("lets Pathway approve or deny %s actions", (provider) =>
    Effect.scoped(
      Effect.gen(function* () {
        let outcome: ComputerApprovalOutcome = "denied";
        const authorizeAction = vi.fn(() => Effect.succeed(outcome));
        const { backend, call } = yield* setupTools(new FakeComputerBackend(), authorizeAction);
        const caller = { ...context(), callerProvider: ProviderDriverKind.make(provider) };
        const typed = () => backend.calls.filter((c) => c.method === "typeText");
        const denied = yield* call(
          "computer_type_text",
          { text: "denied", include_screenshot: false },
          caller,
        );
        expect(denied.isError).toBe(true);
        expect(typed()).toHaveLength(0);
        outcome = "approved";
        const accepted = yield* call(
          "computer_type_text",
          { text: "approved", include_screenshot: false },
          caller,
        );
        expect(accepted.isError).not.toBe(true);
        expect(typed()).toHaveLength(1);
        expect(authorizeAction).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  it.effect("rechecks original turn authority after waiting for the desktop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, backend, call } = yield* setupTools();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          manager.withAgentActivity(
            "audit",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(entered);
        let active = true;
        const caller: ToolContext = {
          ...context(),
          assertCallerTurnActive: () =>
            active
              ? Effect.void
              : Effect.fail(
                  new ComputerToolError({
                    code: "caller_turn_inactive",
                    message: "original turn ended",
                  }),
                ),
        };
        const second = yield* Effect.forkChild(
          call("computer_type_text", { text: "never", include_screenshot: false }, caller),
          { startImmediately: true },
        );
        yield* Effect.yieldNow;
        active = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        expect((yield* Fiber.join(second)).isError).toBe(true);
        expect(backend.calls.filter((c) => c.method === "typeText")).toHaveLength(0);
      }),
    ),
  );
});
