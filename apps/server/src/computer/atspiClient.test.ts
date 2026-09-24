import type { ComputerWindow } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ATSPI_HELPER_PROTOCOL,
  AtspiHelperUnavailableError,
  atspiHelperEnvironment,
  makeAtspiHelperClient,
  type AtspiHelperClientOptions,
} from "./atspiClient.ts";
import { ComputerBackendError } from "./computerErrors.ts";
import {
  DesktopOperationQueue,
  abortDesktop,
  desktopSignal,
  makeDesktopAbort,
} from "./DesktopOperationQueue.ts";

const EMPTY_TREES = { protocol: ATSPI_HELPER_PROTOCOL, trees: [] };
const PROBE_OK = { ok: true, protocol: ATSPI_HELPER_PROTOCOL, atspi: true, reason: null };

const WINDOW: ComputerWindow = {
  id: "window-1",
  title: "Terminal",
  bounds: { x: 0, y: 0, width: 640, height: 480 },
  focused: true,
  minimized: false,
  visible: true,
};

type Message = Record<string, unknown> & { readonly id: number; readonly method: string };

type HelperStream = Queue.Queue<Uint8Array, PlatformError.PlatformError | Cause.Done>;

/**
 * A helper process made of queues. `script` answers each request as it
 * arrives; `received` hands the test every request, in order, to wait on.
 * `stopped` completes when the client stops the process (its spawn scope
 * closed), which is the only way the client ends one.
 */
class FakeHelper {
  readonly received: Queue.Queue<Message>;
  readonly stdout: HelperStream;
  readonly stderr: HelperStream;
  readonly stopped = Deferred.makeUnsafe<void>();
  readonly exited = Deferred.makeUnsafe<
    ChildProcessSpawner.ExitCode,
    PlatformError.PlatformError
  >();
  script: (message: Message, helper: FakeHelper) => void;

  constructor(
    queues: { received: Queue.Queue<Message>; stdout: HelperStream; stderr: HelperStream },
    script: (message: Message, helper: FakeHelper) => void,
  ) {
    this.received = queues.received;
    this.stdout = queues.stdout;
    this.stderr = queues.stderr;
    this.script = script;
  }

  reply(message: Record<string, unknown>): void {
    this.writeStdout(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  answer(id: number, result: unknown): void {
    this.reply({ id, result });
  }

  writeStdout(text: string): void {
    Queue.offerUnsafe(this.stdout, new TextEncoder().encode(text));
  }

  writeStderr(text: string): void {
    Queue.offerUnsafe(this.stderr, new TextEncoder().encode(text));
  }

  /** Exits with a code, or with `code` null and a signal. Stderr closes with it. */
  exit(code: number | null, signal?: string): void {
    Queue.endUnsafe(this.stderr);
    Deferred.doneUnsafe(
      this.exited,
      code === null
        ? Exit.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "exitCode",
              description: `Process interrupted due to receipt of signal: '${signal}'`,
            }),
          )
        : Exit.succeed(ChildProcessSpawner.ExitCode(code)),
    );
  }

  failStream(name: "stdout" | "stderr"): void {
    Queue.failCauseUnsafe(
      this[name],
      Cause.fail(
        PlatformError.systemError({ _tag: "BadResource", module: "Stream", method: name }),
      ),
    );
  }

  get isStopped(): boolean {
    return Deferred.isDoneUnsafe(this.stopped);
  }

  handle(): ChildProcessSpawner.ChildProcessHandle {
    let buffered = "";
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Deferred.await(this.exited),
      isRunning: Effect.sync(() => !Deferred.isDoneUnsafe(this.exited)),
      kill: () => Effect.void,
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Effect.sync(() => {
          buffered += new TextDecoder().decode(chunk);
          let newline = buffered.indexOf("\n");
          while (newline !== -1) {
            // @effect-diagnostics-next-line preferSchemaOverJson:off - the fake reads raw frames.
            const message = JSON.parse(buffered.slice(0, newline)) as Message;
            buffered = buffered.slice(newline + 1);
            Queue.offerUnsafe(this.received, message);
            this.script(message, this);
            newline = buffered.indexOf("\n");
          }
        }),
      ),
      stdout: Stream.fromQueue(this.stdout),
      stderr: Stream.fromQueue(this.stderr),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  }
}

const makeHelper = (script: (message: Message, helper: FakeHelper) => void = () => {}) =>
  Effect.map(
    Effect.all({
      received: Queue.unbounded<Message>(),
      stdout: Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>(),
      stderr: Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>(),
    }),
    (queues) => new FakeHelper(queues, script),
  );

/** Answers every request with `result(message)`. */
const scriptedHelper = (result: (message: Message) => unknown) =>
  makeHelper((message, helper) => helper.answer(message.id, result(message)));

/**
 * A spawner that hands out `next()` for each spawn: a helper, or a spawn
 * failure such as a missing interpreter.
 */
function fakeSpawner(next: () => FakeHelper | "ENOENT") {
  let spawns = 0;
  const service = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      spawns += 1;
      const helper = next();
      if (helper === "ENOENT") {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "spawn python3 ENOENT",
        });
      }
      yield* Effect.addFinalizer(() => Deferred.succeed(helper.stopped, undefined));
      return helper.handle();
    }),
  );
  return { service, spawns: () => spawns };
}

/** A client over `spawner`, stopped with the test's scope. */
const makeClient = (
  spawner: ReturnType<typeof fakeSpawner>,
  options: AtspiHelperClientOptions = {},
) =>
  makeAtspiHelperClient(options).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner.service),
  );

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.orElseSucceed(() => undefined));

/** Starts `effect` now, so the test can move the clock or answer under it. */
const start = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true });

describe("AtspiHelperClient", () => {
  it.effect("stops an idle helper on release and starts a fresh one on the next request", () =>
    Effect.gen(function* () {
      const helpers = [
        yield* scriptedHelper(() => EMPTY_TREES),
        yield* scriptedHelper(() => EMPTY_TREES),
      ];
      const spawner = fakeSpawner(() => helpers[spawner.spawns() - 1]!);
      const client = yield* makeClient(spawner);

      expect(yield* client.readTrees([WINDOW])).toEqual([]);
      yield* client.release;
      yield* Deferred.await(helpers[0]!.stopped);
      // The released helper's exit is ours, not a crash: nothing latches.
      helpers[0]!.exit(null, "SIGTERM");
      expect(yield* client.unavailableReason).toBeUndefined();

      expect(yield* client.readTrees([WINDOW])).toEqual([]);
      expect(spawner.spawns()).toBe(2);
    }),
  );

  it.effect("ignores replies and errors from a helper replaced after a timeout", () =>
    Effect.gen(function* () {
      const oldHelper = yield* makeHelper();
      const helper = yield* makeHelper();
      const spawner = fakeSpawner(() => (spawner.spawns() === 1 ? oldHelper : helper));
      const client = yield* makeClient(spawner, { requestTimeoutMs: 100 });

      const first = yield* start(client.readTrees([WINDOW]));
      yield* Queue.take(oldHelper.received);
      yield* TestClock.adjust("100 millis");
      expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
      yield* Deferred.await(oldHelper.stopped);

      const second = yield* start(client.setText({ window: WINDOW, path: [], text: "value" }));
      // The reconnect backoff after one failure.
      yield* TestClock.adjust("500 millis");
      const request = yield* Queue.take(helper.received);

      // The replaced helper answers the same id with `ok: true` and its
      // streams fail; none of it reaches the request or the new helper.
      oldHelper.answer(request.id, { ok: true });
      oldHelper.failStream("stdout");
      oldHelper.failStream("stderr");
      oldHelper.exit(1);
      helper.answer(request.id, { ok: false });
      expect(yield* Fiber.join(second)).toBe(false);
      expect(helper.isStopped).toBe(false);
    }),
  );

  it.effect.each(["stdout", "stderr"] as const)("contains an idle %s error", (name) =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => EMPTY_TREES);
      const client = yield* makeClient(fakeSpawner(() => helper));
      expect(yield* client.readTrees([WINDOW])).toEqual([]);
      helper.failStream(name);
      yield* Deferred.await(helper.stopped);
    }),
  );

  it.effect("does not send a semantic write cancelled during helper restart", () =>
    Effect.gen(function* () {
      const oldHelper = yield* makeHelper();
      const helper = yield* scriptedHelper(() => ({ ok: true }));
      const spawner = fakeSpawner(() => (spawner.spawns() === 1 ? oldHelper : helper));
      const client = yield* makeClient(spawner, { requestTimeoutMs: 100 });
      const operations = new DesktopOperationQueue();

      const first = yield* start(client.readTrees([WINDOW]));
      yield* Queue.take(oldHelper.received);
      yield* TestClock.adjust("100 millis");
      yield* Fiber.await(first);

      const abort = makeDesktopAbort();
      const write = yield* start(
        operations.run(
          client.setText({ window: WINDOW, path: [], text: "value" }),
          desktopSignal(abort),
        ),
      );
      // Mid-backoff, before the replacement helper exists.
      yield* TestClock.adjust("100 millis");
      yield* abortDesktop(abort, new ComputerBackendError({ message: "cancelled" }));
      yield* TestClock.adjust("400 millis");
      expect((yield* failureOf(Fiber.join(write)))?.message).toBe("cancelled");
      expect(yield* Queue.size(helper.received)).toBe(0);
    }),
  );

  it.effect(
    "starts the timeout only when the single-threaded helper can accept the next request",
    () =>
      Effect.gen(function* () {
        const helper = yield* makeHelper();
        const client = yield* makeClient(
          fakeSpawner(() => helper),
          { requestTimeoutMs: 100 },
        );
        const first = yield* start(client.readTrees([WINDOW]));
        const second = yield* start(client.readTrees([WINDOW]));
        const firstRequest = yield* Queue.take(helper.received);
        yield* TestClock.adjust("80 millis");
        expect(yield* Queue.size(helper.received)).toBe(0);
        helper.answer(firstRequest.id, EMPTY_TREES);
        yield* Fiber.join(first);

        const secondRequest = yield* Queue.take(helper.received);
        yield* TestClock.adjust("80 millis");
        expect(helper.isStopped).toBe(false);
        helper.answer(secondRequest.id, EMPTY_TREES);
        expect(yield* Fiber.join(second)).toEqual([]);
      }),
  );

  it.effect.each([null, ""])("transmits unlabeled node identity: %s", (label) =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => ({ ok: true }));
      const client = yield* makeClient(fakeSpawner(() => helper));
      yield* client.setText({ window: WINDOW, path: [0], text: "value", label });
      expect((yield* Queue.take(helper.received)).params).toMatchObject({ label: "" });
    }),
  );

  it.effect("starts the first helper request without the reconnect backoff", () =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => EMPTY_TREES);
      const client = yield* makeClient(fakeSpawner(() => helper));
      // The test clock never moves: a backoff in front of the first spawn would hang.
      expect(yield* client.readTrees([WINDOW])).toEqual([]);
    }),
  );

  it.effect("addresses a semantic write by window descriptor and child-index path", () =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => ({ ok: true }));
      const client = yield* makeClient(fakeSpawner(() => helper));
      expect(
        yield* client.setText({
          window: WINDOW,
          path: [2, 0],
          text: "héllo",
          role: "entry",
          label: "Name",
        }),
      ).toBe(true);
      expect(yield* Queue.take(helper.received)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "set-text",
        params: {
          protocol: ATSPI_HELPER_PROTOCOL,
          window: {
            id: "window-1",
            title: "Terminal",
            appName: null,
            pid: null,
            bounds: { x: 0, y: 0, width: 640, height: 480 },
          },
          path: [2, 0],
          text: "héllo",
          role: "entry",
          label: "Name",
        },
      });
    }),
  );

  it.effect("reports a refused write as false rather than a failure", () =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => ({ ok: false, reason: "not-editable" }));
      const client = yield* makeClient(fakeSpawner(() => helper));
      expect(yield* client.setText({ window: WINDOW, path: [], text: "x" })).toBe(false);
    }),
  );

  it.effect("propagates a helper error so the caller can fall back", () =>
    Effect.gen(function* () {
      const helper = yield* makeHelper((message, self) =>
        self.reply({
          id: message.id,
          error: { code: -32000, message: "no editable text interface" },
        }),
      );
      const client = yield* makeClient(fakeSpawner(() => helper));
      const error = yield* failureOf(client.setText({ window: WINDOW, path: [0], text: "x" }));
      expect(error?.message).toBe("no editable text interface");
    }),
  );

  /**
   * The helper answering "that window is gone" is routine — it is what a
   * semantic target that closed mid-walk looks like. Killing the process over
   * it respawned Python on every miss and pushed the reconnect backoff to five
   * seconds, so the next perception request paid for a refusal that had nothing
   * wrong with it.
   */
  it.effect("keeps the helper alive when it reports an error instead of dying", () =>
    Effect.gen(function* () {
      const helper = yield* makeHelper((message, self) =>
        self.reply(
          message.method === "read-tree"
            ? { id: message.id, error: { code: -32000, message: "window closed" } }
            : { id: message.id, result: { ok: true } },
        ),
      );
      const spawner = fakeSpawner(() => helper);
      const client = yield* makeClient(spawner);
      expect((yield* failureOf(client.readTrees([WINDOW])))?.message).toBe("window closed");
      expect(helper.isStopped).toBe(false);
      // The same process serves the next call, with no reconnect delay in
      // front of it — the test clock never moves.
      expect(yield* client.setText({ window: WINDOW, path: [0], text: "x" })).toBe(true);
      expect(spawner.spawns()).toBe(1);
    }),
  );

  it.effect("still tears down the helper when the transport itself fails", () =>
    Effect.gen(function* () {
      // Never answers: the request times out, which is a dead transport, not
      // a refusal, and the process must be replaced.
      const helper = yield* makeHelper();
      const client = yield* makeClient(
        fakeSpawner(() => helper),
        { requestTimeoutMs: 5 },
      );
      const read = yield* start(client.readTrees([WINDOW]));
      yield* Queue.take(helper.received);
      yield* TestClock.adjust("5 millis");
      expect(Exit.isFailure(yield* Fiber.await(read))).toBe(true);
      yield* Deferred.await(helper.stopped);
      // A timeout is transient: the next request may still spawn a helper.
      expect(yield* client.unavailableReason).toBeUndefined();
    }),
  );

  it.effect("accepts a partial reply as a normal response from a healthy helper", () =>
    Effect.gen(function* () {
      const tree = {
        windowId: WINDOW.id,
        clientSize: { width: 640, height: 480 },
        root: {
          role: "frame",
          label: "Terminal",
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 640, height: 480 },
          editable: false,
          children: [],
        },
      };
      const helper = yield* scriptedHelper(() => ({
        protocol: ATSPI_HELPER_PROTOCOL,
        trees: [tree],
        partial: true,
      }));
      const spawner = fakeSpawner(() => helper);
      const client = yield* makeClient(spawner);
      expect(yield* client.readTrees([WINDOW])).toEqual([tree]);
      expect(yield* client.readTrees([WINDOW])).toEqual([tree]);
      expect(helper.isStopped).toBe(false);
      expect(spawner.spawns()).toBe(1);
      expect(yield* client.unavailableReason).toBeUndefined();
    }),
  );

  /**
   * A machine without python3 fails every spawn the same way. Before the
   * latch, every tree read paid the spawn plus up to five seconds of backoff
   * to rediscover that, and the reason was never surfaced.
   */
  it.effect("latches unavailable after a spawn failure until probed again", () =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper((message) =>
        message.method === "probe" ? PROBE_OK : EMPTY_TREES,
      );
      let installed = false;
      const spawner = fakeSpawner(() => (installed ? helper : "ENOENT"));
      const client = yield* makeClient(spawner);
      // The test clock never moves: had any call waited on a reconnect
      // backoff or a request timeout it would never settle.
      expect(yield* failureOf(client.readTrees([WINDOW]))).toBeDefined();
      expect(yield* client.unavailableReason).toContain("ENOENT");

      const latched = yield* failureOf(client.readTrees([WINDOW]));
      expect(latched).toBeInstanceOf(AtspiHelperUnavailableError);
      expect(latched?.message).toContain("ENOENT");
      expect(yield* client.setText({ window: WINDOW, path: [0], text: "x" })).toBe(false);
      expect(spawner.spawns()).toBe(1);

      installed = true;
      yield* client.probe;
      expect(yield* client.unavailableReason).toBeUndefined();
      expect(spawner.spawns()).toBe(2);
      expect(yield* client.readTrees([WINDOW])).toEqual([]);
      expect(spawner.spawns()).toBe(2);
    }),
  );

  it.effect("latches unavailable with the stderr tail when the helper dies before answering", () =>
    Effect.gen(function* () {
      const helper = yield* makeHelper((_message, self) => {
        self.writeStderr("Traceback (most recent call last):\n");
        self.writeStderr("ModuleNotFoundError: No module named 'gi'\n");
        self.exit(1);
      });
      const spawner = fakeSpawner(() => helper);
      const client = yield* makeClient(spawner);
      expect((yield* failureOf(client.readTrees([WINDOW])))?.message).toContain(
        "ModuleNotFoundError",
      );
      expect(yield* client.unavailableReason).toContain("No module named 'gi'");
      expect(yield* failureOf(client.readTrees([WINDOW]))).toBeInstanceOf(
        AtspiHelperUnavailableError,
      );
      expect(yield* client.setText({ window: WINDOW, path: [0], text: "x" })).toBe(false);
      expect(spawner.spawns()).toBe(1);
    }),
  );

  it.effect("keeps only a bounded tail of stderr", () =>
    Effect.gen(function* () {
      const helper = yield* makeHelper((_message, self) => {
        self.writeStderr("a".repeat(64 * 1024));
        self.writeStderr("\nlast line\n");
        self.exit(2);
      });
      const client = yield* makeClient(fakeSpawner(() => helper));
      expect((yield* failureOf(client.readTrees([WINDOW])))?.message).toContain("last line");
      const reason = yield* client.unavailableReason;
      expect(reason).toContain("last line");
      expect(reason!.length).toBeLessThan(5 * 1024);
    }),
  );

  it.effect("does not latch on a helper that dies after it has answered", () =>
    Effect.gen(function* () {
      const first = yield* scriptedHelper(() => EMPTY_TREES);
      const second = yield* scriptedHelper(() => EMPTY_TREES);
      const spawner = fakeSpawner(() => (spawner.spawns() === 1 ? first : second));
      const client = yield* makeClient(spawner);
      expect(yield* client.readTrees([WINDOW])).toEqual([]);
      first.exit(1);
      yield* Deferred.await(first.stopped);
      expect(yield* client.unavailableReason).toBeUndefined();

      const next = yield* start(client.readTrees([WINDOW]));
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(next)).toEqual([]);
      expect(spawner.spawns()).toBe(2);
    }),
  );

  it.effect("latches unavailable when the probe reports no AT-SPI bindings", () =>
    Effect.gen(function* () {
      let atspi = false;
      const helper = yield* scriptedHelper(() => ({
        ok: true,
        protocol: ATSPI_HELPER_PROTOCOL,
        atspi,
        reason: atspi ? null : "gi",
      }));
      const spawner = fakeSpawner(() => helper);
      const client = yield* makeClient(spawner);
      yield* client.probe;
      expect(yield* client.unavailableReason).toContain("gi");
      expect(yield* failureOf(client.readTrees([WINDOW]))).toBeInstanceOf(
        AtspiHelperUnavailableError,
      );
      expect(yield* client.setText({ window: WINDOW, path: [0], text: "x" })).toBe(false);
      // The helper answered, so it stays; only the latch stops the requests.
      expect(helper.isStopped).toBe(false);

      atspi = true;
      yield* client.probe;
      expect(yield* client.unavailableReason).toBeUndefined();
      expect(spawner.spawns()).toBe(1);
    }),
  );

  it.effect("runs one probe for concurrent callers and refuses a helper without the probe", () =>
    Effect.gen(function* () {
      const helper = yield* makeHelper((message, self) =>
        self.reply({
          id: message.id,
          error: { code: -32000, message: "Unknown AT-SPI helper method" },
        }),
      );
      const client = yield* makeClient(fakeSpawner(() => helper));
      yield* Effect.all([client.probe, client.probe], { concurrency: "unbounded" });
      expect((yield* Queue.takeAll(helper.received)).map((request) => request.method)).toEqual([
        "probe",
      ]);
      // A helper that cannot answer the probe is not the build this client
      // speaks to; reading its trees would be a guess.
      expect(yield* client.unavailableReason).toContain("probe failed");
      expect(helper.isStopped).toBe(false);
    }),
  );
});

describe("AtspiHelperClient availability", () => {
  /**
   * libatspi aborted the helper on an unreachable accessibility bus, and
   * every read respawned it into the same abort — a core dump and a crash
   * notification each time. A signal before the first tree now latches.
   */
  it.effect("latches a helper killed by a signal before its first tree, with a retry window", () =>
    Effect.gen(function* () {
      const crashing = (message: Message, self: FakeHelper) => {
        if (message.method === "probe") {
          self.answer(message.id, PROBE_OK);
        } else {
          self.writeStderr("dbind-ERROR **: AT-SPI: Couldn't connect to accessibility bus\n");
          self.exit(null, "SIGABRT");
        }
      };
      const helpers = [yield* makeHelper(crashing), yield* makeHelper(crashing)];
      const spawner = fakeSpawner(() => helpers[spawner.spawns() - 1]!);
      const client = yield* makeClient(spawner);

      yield* client.probe;
      expect((yield* failureOf(client.readTrees([WINDOW])))?.message).toContain("SIGABRT");
      expect(yield* client.unavailableReason).toContain("dbind-ERROR");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(yield* failureOf(client.readTrees([WINDOW]))).toBeInstanceOf(
          AtspiHelperUnavailableError,
        );
      }
      expect(spawner.spawns()).toBe(1);

      // Past the retry window one request looks again — and the same crash
      // latches again for twice as long.
      yield* TestClock.adjust("30 seconds");
      expect(yield* client.unavailableReason).toBeUndefined();
      const retry = yield* start(failureOf(client.readTrees([WINDOW])));
      // The reconnect backoff the crash left behind.
      yield* TestClock.adjust("500 millis");
      expect(yield* Fiber.join(retry)).toBeDefined();
      expect(spawner.spawns()).toBe(2);
      yield* TestClock.adjust("30 seconds");
      expect(yield* failureOf(client.readTrees([WINDOW]))).toBeInstanceOf(
        AtspiHelperUnavailableError,
      );
      expect(spawner.spawns()).toBe(2);
    }),
  );

  it.effect("latches an unreachable accessibility bus without killing the helper", () =>
    Effect.gen(function* () {
      const helper = yield* makeHelper((message, self) =>
        self.reply({
          id: message.id,
          error: { code: -32010, message: "org.a11y.Bus is not running" },
        }),
      );
      const client = yield* makeClient(fakeSpawner(() => helper));
      expect(yield* failureOf(client.readTrees([WINDOW]))).toBeInstanceOf(
        AtspiHelperUnavailableError,
      );
      expect(yield* client.unavailableReason).toContain("org.a11y.Bus is not running");
      expect(yield* client.setText({ window: WINDOW, path: [0], text: "x" })).toBe(false);
      expect(
        yield* client.validateNode({ window: WINDOW, path: [0], role: "entry", label: "Name" }),
      ).toEqual({ ok: false, reason: "unavailable" });
      expect(yield* Queue.size(helper.received)).toBe(1);
      expect(helper.isStopped).toBe(false);
    }),
  );

  it.effect("refuses trees from a helper that speaks another protocol", () =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => ({ trees: [] }));
      const client = yield* makeClient(fakeSpawner(() => helper));
      expect(yield* failureOf(client.readTrees([WINDOW]))).toBeInstanceOf(
        AtspiHelperUnavailableError,
      );
      expect(yield* client.unavailableReason).toContain("protocol");
    }),
  );

  it.effect("latches a probe from an older helper as a protocol mismatch", () =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => ({ ok: true, atspi: true, reason: null }));
      const client = yield* makeClient(fakeSpawner(() => helper));
      yield* client.probe;
      expect(yield* client.unavailableReason).toContain(`needs ${ATSPI_HELPER_PROTOCOL}`);
    }),
  );
});

describe("AtspiHelperClient requests", () => {
  it.effect("asks for a cached tree only with an age the caller allows", () =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => EMPTY_TREES);
      const client = yield* makeClient(fakeSpawner(() => helper));
      yield* client.readTrees([WINDOW], { maxAgeMs: 2_500.4 });
      yield* client.readTrees([WINDOW], { maxAgeMs: 0 });
      const [aged, fresh] = yield* Queue.takeAll(helper.received);
      expect(aged!.params).toMatchObject({ protocol: ATSPI_HELPER_PROTOCOL, maxAgeMs: 2_500 });
      expect(fresh!.params).not.toHaveProperty("maxAgeMs");
    }),
  );

  it.effect("validates a node and returns its fresh extents", () =>
    Effect.gen(function* () {
      const helper = yield* scriptedHelper(() => ({
        ok: true,
        frame: { x: 1, y: 2, width: 3, height: 4 },
        clientSize: { width: 640, height: 480 },
        showing: true,
      }));
      const client = yield* makeClient(fakeSpawner(() => helper));
      expect(
        yield* client.validateNode({ window: WINDOW, path: [2, 0], role: "button", label: null }),
      ).toEqual({
        ok: true,
        frame: { x: 1, y: 2, width: 3, height: 4 },
        clientSize: { width: 640, height: 480 },
        showing: true,
      });
      expect(yield* Queue.take(helper.received)).toMatchObject({
        method: "validate-node",
        params: { protocol: ATSPI_HELPER_PROTOCOL, path: [2, 0], role: "button", label: "" },
      });
    }),
  );

  /**
   * One helper, one request at a time: a write or a one-window read queued
   * behind a desktop-wide walk used to wait for all of it, and for every
   * other desktop-wide walk queued before it.
   */
  it.effect("serves writes and scoped reads before queued desktop-wide reads", () =>
    Effect.gen(function* () {
      const helper = yield* makeHelper();
      const other = { ...WINDOW, id: "window-2" };
      const client = yield* makeClient(fakeSpawner(() => helper));
      const fibers: Array<Fiber.Fiber<unknown, unknown>> = [
        yield* start(client.readTrees([WINDOW, other])),
      ];
      let request = yield* Queue.take(helper.received);
      fibers.push(
        yield* start(client.readTrees([WINDOW, other])),
        yield* start(client.setText({ window: WINDOW, path: [0], text: "x" })),
        yield* start(client.readTrees([WINDOW])),
      );
      const methods: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        if (index > 0) request = yield* Queue.take(helper.received);
        const windows = (request.params as { windows?: unknown[] }).windows;
        methods.push(windows ? `${request.method}:${windows.length}` : request.method);
        helper.answer(request.id, windows ? EMPTY_TREES : { ok: true });
      }
      for (const fiber of fibers) yield* Fiber.await(fiber);
      expect(methods).toEqual(["read-tree:2", "set-text", "read-tree:1", "read-tree:2"]);
    }),
  );
});

describe("atspiHelperEnvironment", () => {
  const server = {
    PATH: "/usr/bin",
    AT_SPI_BUS_ADDRESS: "unix:path=/run/user/1000/at-spi/bus_1",
    PATHWAY_AUTH_TOKEN: "secret",
  };

  it("layers the overrides on the server's environment by default", () => {
    expect(
      atspiHelperEnvironment({ env: { DBUS_SESSION_BUS_ADDRESS: "unix:abstract=x" } }, server),
    ).toEqual({ ...server, DBUS_SESSION_BUS_ADDRESS: "unix:abstract=x", PYTHONUNBUFFERED: "1" });
  });

  it("gives exactly the overrides when told not to inherit, host accessibility bus included", () => {
    expect(
      atspiHelperEnvironment(
        {
          env: { PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:abstract=x" },
          inheritEnv: false,
        },
        server,
      ),
    ).toEqual({
      PATH: "/usr/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:abstract=x",
      PYTHONUNBUFFERED: "1",
    });
  });
});
