import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, vi } from "vite-plus/test";

import {
  CUA_NATIVE_REVISION,
  type CuaReply,
  cuaRequest,
} from "@spiritdevs/shared/cuaDriverProtocol";

import type { CuaDriverHost, CuaInputMonitorState } from "./CuaDriverHost.ts";
import { linuxCuaAdmission } from "./LinuxCuaAdmission.ts";
import {
  CAPABILITY,
  type Fixture,
  type FixtureOptions,
  makeFixture,
} from "./testing/CuaDriverFixture.ts";

const task = { threadId: "linux-browser", turnId: "turn" };

/** A Linux host over an upstream driver that reports the verified browser capability. */
const linuxFixture = (options: FixtureOptions = {}) =>
  makeFixture({
    platform: "linux",
    unpatched: true,
    nativeRevision: null,
    reportedRevision: CUA_NATIVE_REVISION,
    browserInputControl: 1,
    inputMonitorState: Effect.succeed({ ready: true }),
    linuxAdmission: linuxCuaAdmission,
    ...options,
  });

const call = (f: Fixture, name: string, args: Record<string, unknown> = {}) =>
  f.send({ method: "call", name, args, task });

const dispatched = (f: Fixture, name: string) =>
  Effect.map(f.eventNames, (events) =>
    events.some((event) => event.startsWith(`browser:${name}:`)),
  );

/** Either side of a call the host settled without a reply body. */
const settled = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, {
    onFailure: (error): unknown => error,
    onSuccess: (reply): unknown => reply,
  });

describe("verified Linux browser input capability", () => {
  for (const options of [
    { browserInputControl: undefined },
    { browserInputControl: true },
    { browserInputControl: "1" },
    { reportedRevision: CUA_NATIVE_REVISION - 1 },
  ]) {
    it.live(
      `refuses browser input with an unverified child capability ${JSON.stringify(options)}`,
      () =>
        Effect.gen(function* () {
          const f = yield* linuxFixture(options);
          const reply = yield* f.send({
            method: "call",
            name: "browser_navigate",
            args: { pathway_browser_input_control: 1, browserInputControlVerified: true },
            browserInputControlVerified: true,
            task,
          });
          expect(reply).toMatchObject({
            hostPlatform: "linux",
            driverBrowserInputControl: false,
            result: { structuredContent: { code: "linux_browser_cleanup_unavailable" } },
          });
          assert.isFalse(yield* dispatched(f, "browser_navigate"));
        }),
    );
  }

  it.live("requires the embedded metadata PID to match the child before trusting its marker", () =>
    Effect.gen(function* () {
      const f = yield* linuxFixture({ metadataPidOffset: 1 });
      const reply = yield* call(f, "browser_navigate");
      expect(reply).toMatchObject({
        ok: false,
        effect: "not-dispatched",
        driverBrowserInputControl: false,
      });
      assert.include(reply.error, "handshake failed");
      assert.isFalse(yield* dispatched(f, "browser_navigate"));
    }),
  );

  it.live(
    "carries verified epochs and native browser drain across disconnect without a cold restart",
    () =>
      Effect.gen(function* () {
        const f = yield* linuxFixture({ browserHang: true, inputDelayMs: 150 });
        const cancel = yield* Deferred.make<void>();
        // The raw client, not f.send: the caller-side failure carries the
        // `effect` verdict this case asserts.
        const typing = yield* cuaRequest<CuaReply>(
          f.endpoint,
          {
            capability: CAPABILITY,
            method: "call",
            name: "browser_type",
            args: { text: "fixture" },
            task,
          },
          { mutation: true, cancel: Deferred.await(cancel) },
        ).pipe(Effect.flip, Effect.forkChild);
        yield* f.waitForEvent("browser-dispatch");
        yield* Deferred.succeed(cancel, undefined);
        expect(yield* Fiber.join(typing)).toMatchObject({ effect: "dispatched-unknown" });
        yield* f.waitForEvent("interrupt");
        const reply = yield* call(f, "browser_navigate");
        assert.isTrue(reply.driverBrowserInputControl);
        assert.deepStrictEqual(reply.result, {});
        // The driver clears the held action's effect timer in the same tick
        // it logs `interrupt`, so a late effect can no longer land.
        const events = yield* f.eventNames;
        assert.lengthOf(
          events.filter((event) => event === "release"),
          1,
        );
        assert.lengthOf(
          events.filter((event) => event === "start"),
          1,
        );
        assert.isAbove(
          events.findIndex((event) => event.startsWith("browser:browser_navigate:")),
          events.indexOf("interrupt-ack"),
        );
        assert.notInclude(events, "browser-effect");
        expect(
          yield* f.send({
            method: "call",
            name: "press_key",
            args: { key: "enter" },
            deliveryMode: "foreground",
            task,
          }),
        ).toMatchObject({
          result: { structuredContent: { code: "linux_input_cleanup_unavailable" } },
        });
        assert.notInclude(yield* f.eventNames, "key");
      }),
  );

  it.live(
    "does not dispatch a cold browser call stopped while its capability handshake is pending",
    () =>
      Effect.gen(function* () {
        const f = yield* linuxFixture({ metadataDelayMs: 100 });
        const navigating = yield* settled(call(f, "browser_navigate")).pipe(Effect.forkChild);
        yield* f.waitForEvent("start");
        yield* f.send({ method: "stop" });
        expect(yield* Fiber.join(navigating)).toMatchObject({
          ok: false,
          effect: "not-dispatched",
        });
        assert.isFalse(yield* dispatched(f, "browser_navigate"));
      }),
  );

  for (const name of ["clipboard_read", "clipboard_write", "kill_app", "move_cursor"]) {
    it.live(
      `preserves the trusted epoch envelope for admitted Linux ${name} without opening synthetic input`,
      () =>
        Effect.gen(function* () {
          const f = yield* linuxFixture();
          assert.deepStrictEqual((yield* call(f, name)).result, {});
          yield* f.send({ method: "stop" });
          assert.deepStrictEqual((yield* call(f, name)).result, {});
          yield* f.waitForEvent(`permitted-native:${name}`, 2);
        }),
    );
  }

  it.live("does not spawn or expose the browser marker to an unauthenticated caller", () =>
    Effect.gen(function* () {
      const f = yield* linuxFixture();
      const reply = yield* f.send({
        method: "call",
        name: "browser_navigate",
        args: {},
        task,
        capability: "not-authorized",
      });
      expect(reply).toMatchObject({
        ok: false,
        effect: "not-dispatched",
        driverBrowserInputControl: false,
      });
      assert.include(reply.error, "authority");
      assert.deepStrictEqual(yield* f.eventNames, []);
    }),
  );

  for (const [label, inputMonitorState] of [
    ["missing", undefined],
    [
      "unavailable",
      Effect.succeed<CuaInputMonitorState>({
        ready: false,
        error: "linux_global_escape_unavailable",
      }),
    ],
  ] as const) {
    it.live(
      `refuses browser mutations with a ${label} Linux Escape listener while retaining reads`,
      () =>
        Effect.gen(function* () {
          const f = yield* makeFixture({
            platform: "linux",
            unpatched: true,
            nativeRevision: null,
            reportedRevision: CUA_NATIVE_REVISION,
            browserInputControl: 1,
            linuxAdmission: linuxCuaAdmission,
            ...(inputMonitorState ? { inputMonitorState } : {}),
          });
          expect(yield* call(f, "browser_navigate")).toMatchObject({
            driverBrowserInputControl: true,
            result: { structuredContent: { code: "input_monitor_unavailable" } },
          });
          assert.deepStrictEqual((yield* call(f, "get_browser_state")).result, {});
          assert.deepStrictEqual(
            (yield* call(f, "browser_dialog", { action: "inspect" })).result,
            {},
          );
          assert.deepStrictEqual(
            (yield* call(f, "browser_prepare", { pid: 700, allow_launch: false })).result,
            {},
          );
          assert.isFalse(yield* dispatched(f, "browser_navigate"));
        }),
    );
  }

  it.live("reports the Linux Escape diagnosis when listener activation itself fences input", () =>
    Effect.gen(function* () {
      let state: CuaInputMonitorState = { ready: false, error: "input_monitor_idle" };
      let host: CuaDriverHost | undefined;
      const f = yield* linuxFixture({
        inputMonitorState: Effect.sync(() => state),
        activateInputMonitor: Effect.suspend(() => {
          state = { ready: false, error: "linux_escape_portal_unverified" };
          return host?.inputMonitorStateChanged(state) ?? Effect.void;
        }),
      });
      host = f.host;
      // Reproduce the real startup order: passive discovery has already warmed
      // the driver, so a failed listener activation invalidates its input epoch.
      yield* call(f, "get_browser_state");
      const reply = yield* call(f, "browser_prepare", { allow_launch: true, windowed: false });
      expect(reply).toMatchObject({
        ok: true,
        result: {
          isError: true,
          structuredContent: {
            effect: "refused",
            code: "input_monitor_unavailable",
            input_monitor_error: "linux_escape_portal_unverified",
          },
        },
      });
      yield* f.waitForEvent("interrupt-ack");
      assert.isFalse(yield* dispatched(f, "browser_prepare"));
    }),
  );

  for (const stopOrder of ["before", "after"] as const) {
    it.live(`preserves a real Stop ${stopOrder} listener failure while activation is pending`, () =>
      Effect.gen(function* () {
        let state: CuaInputMonitorState = { ready: false, error: "input_monitor_idle" };
        const activationStarted = yield* Deferred.make<void>();
        const activationFinished = yield* Deferred.make<void>();
        const f = yield* linuxFixture({
          inputMonitorState: Effect.sync(() => state),
          activateInputMonitor: Deferred.succeed(activationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(activationFinished)),
          ),
        });
        yield* call(f, "get_browser_state");
        const preparing = yield* settled(
          call(f, "browser_prepare", { allow_launch: true, windowed: false }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(activationStarted);
        yield* Effect.gen(function* () {
          if (stopOrder === "before") yield* f.send({ method: "stop" });
          state = { ready: false, error: "linux_escape_portal_unverified" };
          yield* f.host.inputMonitorStateChanged(state);
          if (stopOrder === "after") yield* f.send({ method: "stop" });
        }).pipe(Effect.ensuring(Deferred.succeed(activationFinished, undefined)));
        expect(yield* Fiber.join(preparing)).toMatchObject({
          ok: false,
          error: "Cancelled before listener activation completed.",
          effect: "not-dispatched",
        });
        assert.isFalse(yield* dispatched(f, "browser_prepare"));
      }),
    );
  }

  it.live(
    "arms Linux Escape only for task-attributed work, excluding passive discovery and previews",
    () =>
      Effect.gen(function* () {
        let state: CuaInputMonitorState = { ready: false, error: "input_monitor_idle" };
        const activateInputMonitor = vi.fn(() => {
          state = { ready: true };
        });
        const onInputMonitorArmedChange = vi.fn((armed: boolean) => {
          if (!armed) state = { ready: false, error: "input_monitor_idle" };
        });
        const f = yield* linuxFixture({
          activateInputMonitor: Effect.sync(activateInputMonitor),
          inputMonitorState: Effect.sync(() => state),
          onInputMonitorArmedChange,
        });
        yield* f.send({ method: "probe" });
        yield* f.send({ method: "call", name: "clipboard_read", args: {} });
        const unattributed = yield* f.send({ method: "call", name: "browser_navigate", args: {} });
        assert.include(unattributed.error, "task attribution");
        yield* call(f, "browser_prepare", { pid: 700, allow_launch: false });
        yield* f.send({
          method: "call",
          name: "get_browser_state",
          args: {},
          modelObservation: false,
          task,
        });
        expect(activateInputMonitor).not.toHaveBeenCalled();
        expect(onInputMonitorArmedChange).not.toHaveBeenCalled();
        assert.deepStrictEqual((yield* call(f, "browser_navigate")).result, {});
        expect(activateInputMonitor).toHaveBeenCalledTimes(1);
        yield* f.send({ method: "end_task", task });
        expect(onInputMonitorArmedChange).toHaveBeenLastCalledWith(false);
        assert.isFalse(yield* f.host.isInputMonitorRequested);
      }),
  );

  it.live(
    "refuses Linux browser dispatch if its Escape listener is lost during session setup",
    () =>
      Effect.gen(function* () {
        let checks = 0;
        const f = yield* linuxFixture({
          inputMonitorState: Effect.sync(
            (): CuaInputMonitorState =>
              ++checks === 1
                ? { ready: true }
                : { ready: false, error: "linux_escape_shortcut_lost" },
          ),
        });
        const reply = yield* call(f, "browser_navigate");
        expect(reply.result?.structuredContent).toMatchObject({
          code: "input_monitor_unavailable",
          input_monitor_error: "linux_escape_shortcut_lost",
        });
        assert.isFalse(yield* dispatched(f, "browser_navigate"));
      }),
  );
});
