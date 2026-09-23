// @effect-diagnostics nodeBuiltinImport:off -- the UTF-8 case writes a raw request to the host socket in two chunks.
import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { type CuaReply, CuaTransportError, cuaRequest } from "@spiritdevs/shared/cuaDriverProtocol";

import { CuaHostError, type CuaHostPermissions } from "./CuaDriverHost.ts";
import { CAPABILITY, type Fixture, makeFixture } from "./testing/CuaDriverFixture.ts";

/**
 * One authenticated request that keeps the transport error itself, so a
 * rejection's delivery verdict (`effect`) stays assertable.
 */
const rawSend = (
  f: Fixture,
  body: Record<string, unknown>,
  options: { readonly timeoutMs?: number; readonly mutation?: boolean },
) =>
  Effect.tryPromise({
    try: () => cuaRequest<CuaReply>(f.endpoint, { capability: CAPABILITY, ...body }, options),
    catch: (cause) =>
      cause instanceof CuaTransportError
        ? cause
        : new CuaTransportError(String(cause), "not-dispatched"),
  });

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const decodeJson = Schema.decodeUnknownEffect(Json);

describe("Cua macOS host retirement", () => {
  it.live("starts the compact cursor once per generation and owns the observation budget", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      for (let i = 0; i < 2; i++) {
        const reply = yield* f.send({
          method: "call",
          name: "press_key",
          args: { key: "enter", _pathway_foreground_observation_ms: 0 },
        });
        assert.isTrue(reply.ok);
        assert.strictEqual(reply.hostPlatform, "darwin");
      }
      const events = yield* f.eventNames;
      assert.lengthOf(
        events.filter((event) => event === "motion-100-0"),
        1,
      );
      assert.lengthOf(
        events.filter((event) => event === "observation-budget-100"),
        2,
      );
    }),
  );

  for (const method of ["stop", "suspend", "pauseDesktop"] as const) {
    it.live(`${method} does not wait for another feature's permission dialog`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const pending = yield* Deferred.make<CuaHostPermissions>();
        const f = yield* makeFixture({
          checkPermissions: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(pending))),
        });
        const check = yield* f
          .send({ method: "call", name: "check_permissions" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* method === "pauseDesktop" ? f.host.pauseDesktop("screen-lock") : f.host[method];
        expect(yield* Fiber.join(check)).toMatchObject({ ok: false, effect: "not-dispatched" });
        // Releasing this Computer wait does not cancel the shared request.
        yield* Deferred.succeed(pending, { accessibility: true, screenRecording: true });
        assert.lengthOf(yield* f.events, 0);
      }),
    );
  }

  it.live("releases a disconnected permission check without retiring a later native session", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const pending = yield* Deferred.make<CuaHostPermissions>();
      const f = yield* makeFixture({
        checkPermissions: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(pending))),
      });
      const check = yield* f
        .send({ method: "call", name: "check_permissions" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(check);
      expect(
        yield* f.send({ method: "call", name: "get_screen_size" }, { timeoutMs: 5_000 }),
      ).toMatchObject({ ok: true });
      yield* Deferred.succeed(pending, { accessibility: true, screenRecording: true });
      expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({ ok: true });
      assert.strictEqual(yield* f.count("start"), 1);
    }),
  );

  it.live(
    "checks permissions through the fresh shared helper without starting Cua or requesting grants",
    () =>
      Effect.gen(function* () {
        let permissions: CuaHostPermissions = { accessibility: false, screenRecording: false };
        const f = yield* makeFixture({ checkPermissions: () => Effect.sync(() => permissions) });
        const check = () =>
          f.send({ method: "call", name: "check_permissions", args: { prompt: true } });
        expect(yield* check()).toMatchObject({
          result: {
            structuredContent: {
              accessibility: false,
              screen_recording: false,
              source: {
                attribution: "host",
                host_bundle_id: "fixture",
                probe: "pathway-helper-permissions",
              },
            },
          },
        });
        permissions = { accessibility: true, screenRecording: true };
        expect(yield* check()).toMatchObject({
          result: { structuredContent: { accessibility: true, screen_recording: true } },
        });
        assert.lengthOf(yield* f.events, 0);
      }),
  );

  it.live(
    "requires an uncached confirming read before accepting a changed permission snapshot",
    () =>
      Effect.gen(function* () {
        let granted = false;
        const checks: boolean[] = [];
        const f = yield* makeFixture({
          checkPermissions: (options) =>
            Effect.sync(() => {
              checks.push(options.force);
              return { accessibility: granted, screenRecording: granted };
            }),
        });
        yield* f.send({ method: "call", name: "check_permissions" });
        granted = true;
        yield* f.send({ method: "call", name: "check_permissions" });
        assert.deepStrictEqual(checks, [false, false, true]);
      }),
  );

  it.live(
    "retires a cached native process once when grants change, then requires fresh observation",
    () =>
      Effect.gen(function* () {
        let granted = true;
        const f = yield* makeFixture({
          checkPermissions: () =>
            Effect.sync(() => ({ accessibility: granted, screenRecording: granted })),
        });
        const check = () => f.send({ method: "call", name: "check_permissions" });
        yield* check();
        yield* f.send({ method: "call", name: "get_screen_size" });
        granted = false;
        expect(yield* check()).toMatchObject({
          desktopEpoch: 1,
          result: { structuredContent: { accessibility: false } },
        });
        assert.strictEqual(yield* f.count("cleanup-ack"), 1);
        yield* check();
        assert.strictEqual(yield* f.count("start"), 1);
        granted = true;
        yield* check();
        expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({
          result: { isError: true },
        });
        yield* f.send({ method: "call", name: "get_window_state", modelObservation: true });
        expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({ ok: true });
        assert.strictEqual(yield* f.count("start"), 2);
      }),
  );

  it.live("does not bypass failed cleanup when refreshed permissions change", () =>
    Effect.gen(function* () {
      let granted = true;
      const f = yield* makeFixture({
        cleanup: "incomplete",
        checkPermissions: () =>
          Effect.sync(() => ({ accessibility: granted, screenRecording: granted })),
      });
      yield* f.send({ method: "call", name: "check_permissions" });
      yield* f.send({ method: "call", name: "get_screen_size" });
      // A dispatched action makes this generation's input state unprovable, so
      // the failed cleanup must keep the driver alive and admission closed.
      yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } });
      granted = false;
      expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
        ok: false,
      });
      expect(
        yield* f.send({ method: "call", name: "get_window_state", modelObservation: true }),
      ).toMatchObject({ ok: false });
      assert.strictEqual(yield* f.count("start"), 1);
    }),
  );

  it.live("does not start while locked and requires fresh state after all desktop pauses end", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.host.pauseDesktop("screen-lock");
      yield* f.host.pauseDesktop("system-sleep");
      yield* f.host.resume; // A backend restart cannot unlock the desktop.
      const press = () => f.send({ method: "call", name: "press_key" });
      expect(yield* press()).toMatchObject({
        result: {
          isError: true,
          structuredContent: { code: "computer_input_paused", effect: "refused" },
        },
      });
      assert.lengthOf(yield* f.events, 0);
      yield* f.host.resumeDesktop("screen-lock");
      expect(yield* press()).toMatchObject({ result: { isError: true } });
      yield* f.host.resumeDesktop("system-sleep");
      yield* f.send({ method: "call", name: "check_permissions" });
      expect(yield* press()).toMatchObject({ result: { isError: true } });
      yield* f.send({
        method: "call",
        name: "get_window_state",
        modelObservation: true,
        args: { pid: 1, window_id: 2 },
      });
      expect(yield* press()).toMatchObject({ ok: true });
      assert.strictEqual(yield* f.count("key"), 1);
    }),
  );

  it.live("lets a task open an app after unlock, before it has anything to observe", () =>
    Effect.gen(function* () {
      // "Open Calculator" after sleep: the app has no window yet, so requiring a
      // fresh look first would leave the task nothing it could observe.
      const f = yield* makeFixture();
      yield* f.host.pauseDesktop("screen-lock");
      const launch = () =>
        f.send({ method: "call", name: "launch_app", args: { name: "Calculator" } });
      expect(yield* launch()).toMatchObject({
        result: { structuredContent: { code: "computer_input_paused" } },
      });
      yield* f.host.resumeDesktop("screen-lock");
      const launched = yield* launch();
      assert.isTrue(launched.ok);
      assert.isUndefined(launched.result?.structuredContent?.code);
      // Acting on something on screen still needs the fresh look.
      expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({
        result: { structuredContent: { code: "computer_input_paused" } },
      });
    }),
  );

  it.live("piggybacks sorted pauses and the never-reset interruption count on every reply", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const probe = () => f.send({ method: "probe" });
      expect(yield* probe()).toMatchObject({
        desktopEpoch: 0,
        desktopPauses: [],
        desktopInterruptions: 0,
      });
      yield* f.host.pauseDesktop("system-sleep");
      yield* f.host.pauseDesktop("screen-lock");
      const paused = yield* probe();
      assert.deepStrictEqual(paused.desktopPauses, ["screen-lock", "system-sleep"]);
      assert.strictEqual(paused.desktopInterruptions, 2);
      // Refusals carry the same state: a paused action reports the reasons and
      // the count alongside its computer_input_paused result.
      expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({
        desktopPauses: ["screen-lock", "system-sleep"],
        desktopInterruptions: 2,
        result: { structuredContent: { code: "computer_input_paused" } },
      });
      // The reasons net back to empty on resume while the count keeps the
      // proof that the interruption cycle ran.
      yield* f.host.resumeDesktop("screen-lock");
      expect(yield* probe()).toMatchObject({
        desktopPauses: ["system-sleep"],
        desktopInterruptions: 2,
      });
      yield* f.host.resumeDesktop("system-sleep");
      expect(yield* probe()).toMatchObject({ desktopPauses: [], desktopInterruptions: 2 });
    }),
  );

  it.live("retires a driver-ended session and retries once with a fresh one", () =>
    Effect.gen(function* () {
      // The driver can end a session the host still holds (restart, timeout).
      // Without a heal, every later call fails the same way and no model-side
      // retry can recover. The driver confirms nothing dispatched, so one
      // retire-plus-retry is replay-safe.
      const f = yield* makeFixture({ sessionDeathOnce: true });
      const reply = yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } });
      assert.isTrue(reply.ok);
      assert.notStrictEqual(reply.result?.isError, true);
      // The dead generation retired (new driver process) and the key reached
      // the fresh session exactly once.
      assert.strictEqual(yield* f.count("start"), 2);
      assert.strictEqual(yield* f.count("key"), 1);
    }),
  );

  it.live("retires a transport-reported session death and retries once fresh", () =>
    Effect.gen(function* () {
      // The live driver surfaced session death as an ok:false reply rather than
      // an isError result: undetected, every later call died on the same id.
      const f = yield* makeFixture({ sessionDeathTransport: true });
      const reply = yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } });
      assert.isTrue(reply.ok);
      assert.notStrictEqual(reply.result?.isError, true);
      assert.strictEqual(yield* f.count("start"), 2);
      assert.strictEqual(yield* f.count("key"), 1);
    }),
  );

  it.live("locking cancels active native input and rejects waiting input before dispatch", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const active = yield* f
        .send({ method: "call", name: "type_text", args: { text: "fixture" } })
        .pipe(Effect.forkChild);
      yield* f.waitForEvent("dispatch");
      const queued = yield* f
        .send<CuaReply>({ method: "call", name: "press_key" })
        .pipe(Effect.forkChild);
      yield* f.host.pauseDesktop("screen-lock");
      expect(yield* Fiber.join(active)).toMatchObject({ ok: false });
      const queuedReply = yield* Fiber.join(queued);
      assert.isTrue(queuedReply.ok === false || queuedReply.result?.isError === true);
      const events = yield* f.eventNames;
      assert.include(events, "cleanup-ack");
      assert.notInclude(events, "effect");
      assert.notInclude(events, "key");
    }),
  );

  it.live("unlock does not bypass an unacknowledged cleanup barrier", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ cleanup: "incomplete" });
      yield* f.send({ method: "call", name: "check_permissions" });
      yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } });
      const paused = yield* Effect.flip(f.host.pauseDesktop("screen-lock"));
      assert.include(paused.message, "did not confirm native input cleanup");
      yield* f.host.resumeDesktop("screen-lock");
      expect(yield* f.send({ method: "call", name: "get_window_state" })).toMatchObject({
        ok: false,
      });
      assert.strictEqual(yield* f.count("start"), 1);
    }),
  );

  it.live("preview and readiness reads cannot release the post-unlock model observation gate", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.host.pauseDesktop("screen-lock");
      yield* f.host.resumeDesktop("screen-lock");
      const press = () => f.send({ method: "call", name: "press_key" });
      expect(yield* f.send({ method: "call", name: "get_desktop_state" })).toMatchObject({
        ok: true,
        desktopEpoch: 1,
      });
      yield* f.send({ method: "call", name: "get_window_state" });
      yield* f.send({
        method: "call",
        name: "get_window_state",
        modelObservation: true,
        args: { empty: true },
      });
      expect(yield* f.send({ method: "call", name: "check_input_ready" })).toMatchObject({
        result: { isError: true },
      });
      expect(yield* press()).toMatchObject({ result: { isError: true } });
      yield* f.send({ method: "call", name: "get_window_state", modelObservation: true });
      expect(yield* press()).toMatchObject({ ok: true });
      assert.strictEqual(yield* f.count("key"), 1);
    }),
  );

  it.live("a disconnected observation cannot release the post-unlock gate", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ delayObservation: true });
      yield* f.host.pauseDesktop("screen-lock");
      yield* f.host.resumeDesktop("screen-lock");
      const controller = new AbortController();
      const observation = yield* f
        .send(
          { method: "call", name: "get_window_state", modelObservation: true },
          { signal: controller.signal },
        )
        .pipe(Effect.forkChild);
      yield* f.waitForEvent("observe");
      controller.abort();
      assert.instanceOf(yield* Effect.flip(Fiber.join(observation)), CuaHostError);
      // The press queues behind the abandoned observation on the host's
      // operation queue, so it sees whatever that observation left behind.
      expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({
        result: { isError: true },
      });
      assert.notInclude(yield* f.eventNames, "key");
    }),
  );

  it.live("ignores a permission probe that reverts on the confirming re-read", () =>
    Effect.gen(function* () {
      // The pathway-helper can read TCC mid-transition and report a grant that
      // the next probe reverts. Arming the gate on that phantom read deadlocked
      // production: every action runs check_permissions first via refresh(), so
      // the helper re-armed the gate after each observation cleared it.
      let probes = 0;
      const f = yield* makeFixture({
        checkPermissions: () =>
          Effect.sync(() => {
            probes += 1;
            return { accessibility: true, screenRecording: probes !== 2 };
          }),
      });
      const check = () => f.send({ method: "call", name: "check_permissions" });
      expect(yield* check()).toMatchObject({ desktopEpoch: 0 });
      expect(yield* check()).toMatchObject({
        desktopEpoch: 0,
        result: { structuredContent: { screen_recording: true } },
      });
      assert.strictEqual(probes, 3);
      expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({ ok: true });
    }),
  );

  it.live("a flapping permission helper cannot deadlock input behind the observation gate", () =>
    Effect.gen(function* () {
      let probes = 0;
      const f = yield* makeFixture({
        checkPermissions: () =>
          Effect.sync(() => {
            probes += 1;
            return { accessibility: true, screenRecording: probes % 2 === 1 };
          }),
      });
      const check = () => f.send({ method: "call", name: "check_permissions" });
      const observe = () =>
        f.send({
          method: "call",
          name: "get_window_state",
          modelObservation: true,
          args: { pid: 1, window_id: 2 },
        });
      yield* check();
      yield* f.host.pauseDesktop("screen-lock");
      yield* f.host.resumeDesktop("screen-lock");
      for (let i = 0; i < 3; i += 1) {
        yield* observe();
        yield* check();
        expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({ ok: true });
      }
    }),
  );

  it.live("refuses an observation a stop interrupted instead of silently voiding the clear", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ delayObservation: true });
      yield* f.host.pauseDesktop("screen-lock");
      yield* f.host.resumeDesktop("screen-lock");
      const observe = () =>
        f.send({
          method: "call",
          name: "get_window_state",
          modelObservation: true,
          args: { pid: 1, window_id: 2 },
        });
      const interrupted = yield* observe().pipe(Effect.forkChild);
      yield* f.waitForEvent("observe");
      // stopInput (turn Stop/revokeControl) used to bump only the input epoch:
      // the in-flight image still returned while its gate clear was skipped.
      yield* f.send({ method: "stop" });
      expect(yield* Fiber.join(interrupted)).toMatchObject({
        result: { isError: true, structuredContent: { code: "computer_input_paused" } },
      });
      yield* observe();
      expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({ ok: true });
    }),
  );

  it.live("preserves multibyte UTF-8 across incoming socket chunks", () =>
    Effect.gen(function* () {
      const authority = CAPABILITY + "-è🧪";
      const f = yield* makeFixture({ capability: authority });
      const request = Buffer.from(
        (yield* encodeJson({ method: "probe", capability: authority })) + "\n",
      );
      const split = request.indexOf(Buffer.from("🧪")) + 1;
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => NodeNet.createConnection(f.endpoint)),
        (socket) => Effect.sync(() => socket.destroy()),
      );
      let result = "";
      socket.on("data", (chunk: Buffer) => {
        result += chunk.toString("utf8");
      });
      const ended = Effect.callback<string, Error>((resume) => {
        socket.once("error", (error) => resume(Effect.fail(error)));
        socket.once("end", () => resume(Effect.succeed(result)));
      }).pipe(Effect.timeout("2 seconds"));
      const reply = yield* ended.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.callback<void>((resume) => {
        socket.once("connect", () => resume(Effect.void));
      });
      yield* Effect.callback<void>((resume) => {
        socket.write(request.subarray(0, split), () => resume(Effect.void));
      });
      // The first half is in the host's socket buffer before this probe's
      // connection opens, so the host has read it by the time the probe
      // replies: the second half cannot land in the same read.
      yield* f.send({ method: "probe" });
      socket.write(request.subarray(split));
      expect(yield* decodeJson(yield* Fiber.join(reply))).toMatchObject({ ok: true });
      assert.lengthOf(yield* f.events, 0);
    }),
  );

  it.live("requires GUI authority even when a provider discovers the socket", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      // An undefined capability is dropped on the wire, as a raw request omits it.
      expect(
        yield* f.send({ method: "call", name: "check_permissions", capability: undefined }),
      ).toMatchObject({ ok: false });
      assert.lengthOf(yield* f.events, 0);
    }),
  );

  it.live("releases uncertain input before termination and waits for exit before replacement", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.send({ method: "call", name: "check_permissions", args: {} });
      const typing = yield* Effect.flip(
        rawSend(
          f,
          { method: "call", name: "type_text", args: { text: "fixture" } },
          { timeoutMs: 120, mutation: true },
        ),
      );
      expect(typing).toMatchObject({ effect: "dispatched-unknown" });
      yield* f.host.stop;
      yield* f.host.stop;
      expect(yield* f.send({ method: "call", name: "check_permissions", args: {} })).toMatchObject({
        ok: true,
      });
      const events = yield* f.events;
      const starts = events.filter((e) => e.event === "start");
      assert.lengthOf(starts, 2);
      const [first, second] = starts;
      assert.isDefined(first);
      assert.isDefined(second);
      const exit = events.find((e) => e.event === "exit" && e.pid === first.pid);
      assert.isDefined(exit);
      assert.isAtLeast(second.time, exit.time);
      assert.isFalse(events.some((e) => e.event === "effect"));
      assert.lengthOf(
        events.filter((e) => e.event === "dispatch"),
        1,
      );
      assert.deepStrictEqual(
        events.filter((e) => e.pid === first.pid).map((e) => e.event),
        [
          "start",
          "motion-100-0",
          "dispatch",
          "cancel",
          "release",
          "cleanup-ack",
          "retiring",
          "exit",
        ],
      );
    }),
  );

  it.live("releases held input through the helper when the driver dies mid-action", () =>
    Effect.gen(function* () {
      let releaseCalls = 0;
      const f = yield* makeFixture({
        crash: true,
        releaseHeldInput: Effect.sync(() => {
          releaseCalls += 1;
        }),
      });
      yield* f.send({ method: "call", name: "check_permissions" });
      // The fake driver exits on dispatch, so the call's retire runs the
      // OS-level release before the request reports its failure.
      expect(
        yield* f.send(
          { method: "call", name: "type_text", args: { text: "fixture" } },
          { timeoutMs: 300, mutation: true },
        ),
      ).toMatchObject({ ok: false });
      assert.strictEqual(releaseCalls, 1);
      // A confirmed release makes the desktop provably clean: the dead
      // generation clears, so the next request spawns a replacement instead of
      // poisoning admission for the host's lifetime.
      expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
        ok: true,
      });
      assert.strictEqual(yield* f.count("start"), 2);
    }),
  );

  it.live("keeps admission closed for the host's lifetime when held-input release fails", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        crash: true,
        releaseHeldInput: Effect.fail({ message: "helper gone" }),
      });
      expect(
        yield* f.send(
          { method: "call", name: "type_text", args: { text: "fixture" } },
          { timeoutMs: 1_000, mutation: true },
        ),
      ).toMatchObject({ ok: false });
      // Without a confirmed release the held state is unprovable — no
      // replacement generation may spawn over it, now or later.
      expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
        ok: false,
        effect: "not-dispatched",
      });
      assert.strictEqual(yield* f.count("start"), 1);
      const stopped = yield* Effect.flip(f.host.stop);
      assert.include(stopped.message, "admission is closed");
    }),
  );

  it.live("replaces a driver that wedges during startup instead of closing admission", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ hangSession: true, dropCancel: true, startupTimeoutMs: 150 });
      // The wedged startup call is bounded by the startup timeout; its
      // retirement cannot confirm cleanup (the socket drops mid-request), but
      // no action ever reached this generation so nothing can be held.
      expect(
        yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } }),
      ).toMatchObject({ ok: false, effect: "not-dispatched" });
      // Terminating the provably input-free generation clears it, so the next
      // request spawns a fresh driver instead of failing closed forever.
      expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
        ok: true,
      });
      const events = yield* f.events;
      const starts = events.filter((event) => event.event === "start");
      assert.lengthOf(starts, 2);
      const [first] = starts;
      assert.isDefined(first);
      assert.deepStrictEqual(
        events.filter((e) => e.pid === first.pid).map((e) => e.event),
        ["start", "session-hang", "cancel", "retiring", "exit"],
      );
    }),
  );

  it.live(
    "rejects later backend requests throughout suspension and resumes only on explicit restart",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.send({ method: "call", name: "check_permissions" });
        // Suspension begins synchronously; the request below must not wait for it.
        const stopping = yield* f.host.suspend.pipe(Effect.forkChild({ startImmediately: true }));
        expect(
          yield* f.send({
            method: "call",
            name: "type_text",
            args: { text: "must not arrive" },
          }),
        ).toMatchObject({
          ok: false,
          effect: "not-dispatched",
          error: expect.stringContaining("suspended"),
        });
        yield* Fiber.join(stopping);
        expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
          ok: false,
          effect: "not-dispatched",
        });
        assert.strictEqual(yield* f.count("start"), 1);
        assert.notInclude(yield* f.eventNames, "dispatch");
        yield* f.host.resume;
        expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
          ok: true,
        });
        const events = yield* f.events;
        const starts = events.filter((event) => event.event === "start");
        assert.lengthOf(starts, 2);
        const [first, second] = starts;
        assert.isDefined(first);
        assert.isDefined(second);
        const exit = events.find((event) => event.event === "exit" && event.pid === first.pid);
        assert.isDefined(exit);
        assert.isAtLeast(second.time, exit.time);
      }),
  );

  it.live("does not let resume bypass failed cleanup during backend suspension", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ cleanup: "incomplete" });
      yield* f.send({ method: "call", name: "check_permissions" });
      yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } });
      const suspended = yield* Effect.flip(f.host.suspend);
      assert.include(suspended.message, "did not confirm native input cleanup");
      yield* f.host.resume;
      expect(
        yield* f.send({
          method: "call",
          name: "type_text",
          args: { text: "must not arrive" },
        }),
      ).toMatchObject({ ok: false, effect: "not-dispatched" });
      assert.strictEqual(yield* f.count("start"), 1);
      assert.notInclude(yield* f.eventNames, "dispatch");
    }),
  );

  for (const cleanup of ["incomplete", "wrong-pid", "missing-admission"] as const) {
    it.live(`keeps the process alive and blocks replacement after ${cleanup} cleanup`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ cleanup });
        yield* f.send({ method: "call", name: "check_permissions" });
        // An input-dispatched generation can hold OS state the acknowledgement
        // cannot account for, so the driver stays alive and unreplaced.
        yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } });
        const stopped = yield* Effect.flip(f.host.stop);
        assert.include(stopped.message, "did not confirm native input cleanup");
        expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
          ok: false,
          effect: "not-dispatched",
        });
        const events = yield* f.events;
        assert.deepStrictEqual(
          events.map((e) => e.event),
          ["start", "motion-100-0", "key", "observation-budget-100", "cancel", "cleanup-ack"],
        );
        const [first] = events;
        assert.isDefined(first);
        assert.doesNotThrow(() => process.kill(first.pid, 0));
      }),
    );
  }

  it.live("preserves an uncertain action effect when cleanup also fails", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ cleanup: "incomplete", failAction: true });
      expect(
        yield* f.send({ method: "call", name: "type_text", args: { text: "fixture" } }),
      ).toMatchObject({
        ok: false,
        effect: "dispatched-unknown",
        error: expect.stringContaining("did not confirm native input cleanup"),
      });
      assert.notInclude(yield* f.eventNames, "retiring");
    }),
  );

  it.live("blocks replacement when a driver crashes during input", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ crash: true });
      expect(
        yield* f.send({ method: "call", name: "type_text", args: { text: "fixture" } }),
      ).toMatchObject({ ok: false, effect: "dispatched-unknown" });
      expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
        ok: false,
        effect: "not-dispatched",
      });
      assert.strictEqual(yield* f.count("start"), 1);
    }),
  );

  it.live("rejects an upstream binary before native input is admitted", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ unpatched: true });
      // The default host still expects the patched build, so it passes the
      // Pathway cursor flags — a faithful upstream binary exits on arguments it
      // cannot parse, which refuses the call before any input is dispatched.
      // Even a binary that tolerated them would fail the revision handshake.
      expect(
        yield* f.send({ method: "call", name: "type_text", args: { text: "fixture" } }),
      ).toMatchObject({ ok: false, effect: "not-dispatched" });
      assert.deepStrictEqual(yield* f.eventNames, ["start"]);
    }),
  );

  it.live("drives an unpatched upstream binary when nativeRevision is null", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ unpatched: true, nativeRevision: null });
      // The upstream spawn omits the Pathway cursor flags (the fake would exit
      // on them), the handshake accepts the absent revision field, and replies
      // report the observed driver as unpatched — the backend's cue to narrow
      // advertised capabilities.
      expect(
        yield* f.send({ method: "call", name: "list_windows", args: {}, capability: CAPABILITY }),
      ).toMatchObject({ ok: true, driverNativeRevision: 0 });
      assert.deepStrictEqual(yield* f.eventNames, ["start", "motion-100-0", "list-windows"]);
    }),
  );

  it.live("refuses unlisted driver operations before starting a daemon", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const response = yield* f.send<{ ok: boolean }>({
        method: "call",
        name: "browser_navigate",
        args: { url: "https://example.com" },
      });
      assert.isFalse(response.ok);
      assert.lengthOf(yield* f.events, 0);
    }),
  );

  it.live("admits wait_for_settle as a read through the allowlist", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      // The fixture driver answers any listed name {}; the allowlist is what a
      // refused name would have failed inside the host before ever spawning.
      expect(
        yield* f.send({
          method: "call",
          name: "wait_for_settle",
          args: { pid: 42, window_id: 10, timeout_ms: 5_000, quiet_ms: 1_000 },
        }),
      ).toMatchObject({ ok: true });
      assert.include(yield* f.eventNames, "start");
    }),
  );
});
