// @effect-diagnostics nodeBuiltinImport:off - the platform guards and the private bus run synchronously at collection.
/**
 * The AT-SPI helper's own tests, and its request framing, run against the real
 * interpreter. `atspi_helper_test.py` exercises the search, scoring, budget and
 * write logic through fakes; the framing tests below drive the real process
 * through its stdio with the malformed input a live client can produce and
 * check that each line costs exactly one reply and never the process.
 *
 * Nothing here touches a live accessibility bus: the unit tests fake the
 * D-Bus transport, and the process tests run under an environment that points
 * AT-SPI at a dead socket — or at a private session bus with no accessibility
 * bus launcher on it — which is also how they prove that an unreachable bus is
 * an error reply and never a crashed helper.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const HELPER_DIR = import.meta.dirname;
const HELPER_PATH = join(HELPER_DIR, "atspi_helper.py");
const UNITTEST_FILE = "atspi_helper_test.py";
const PYTHON = process.env.PATHWAY_ATSPI_PYTHON ?? "python3";
const hasPython = spawnSync(PYTHON, ["--version"], { stdio: "ignore" }).status === 0;
const hasGi =
  hasPython &&
  spawnSync(PYTHON, ["-c", "from gi.repository import Gio, GLib"], { stdio: "ignore" }).status ===
    0;
const hasDbusDaemon = spawnSync("dbus-daemon", ["--version"], { stdio: "ignore" }).status === 0;
const BUS_UNAVAILABLE_ERROR = -32010;
const PROTOCOL_MISMATCH_ERROR = -32011;
/** Bound on one reply from a freshly spawned helper, interpreter start included. */
const REPLY_TIMEOUT = "20 seconds";
const HELPER_ENV: Record<string, string | undefined> = {
  ...process.env,
  PYTHONUNBUFFERED: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  // Even if a request slipped past the pre-Atspi paths, there is no bus here.
  AT_SPI_BUS_ADDRESS: "unix:path=/nonexistent/pathway-atspi-helper-test",
  NO_AT_BRIDGE: "1",
};

describe.skipIf(!hasPython)("atspi_helper.py", () => {
  it.live(
    "passes its python unit tests",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // unittest turns a file path into a module name relative to the cwd,
        // so the run is anchored in the helper's directory rather than
        // wherever Vitest happens to be running from.
        const child = yield* spawner.spawn(
          ChildProcess.make(PYTHON, ["-m", "unittest", UNITTEST_FILE], {
            cwd: HELPER_DIR,
            env: definedEnv(HELPER_ENV),
            extendEnv: false,
          }),
        );
        const [output, code] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(child.all)), child.exitCode],
          { concurrency: "unbounded" },
        );
        if (code !== 0) expect.fail(`python unittest exited with ${code}\n${output}`);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );

  describe("framing", () => {
    it.live("answers invalid UTF-8 with one error line for a null id", () =>
      withHelper((helper) =>
        // `{"\xff\xfe"}`: the bad bytes decode with replacement and the line
        // then fails to parse, so no request id is ever known.
        Effect.map(
          helper.exchange(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a])),
          (reply) => expectErrorReply(reply, null),
        ),
      ),
    );

    it.live("answers an unterminated JSON object with one error line for a null id", () =>
      withHelper((helper) =>
        Effect.map(helper.exchange('{"jsonrpc":"2.0","id":3,"method":"probe"\n'), (reply) =>
          expectErrorReply(reply, null),
        ),
      ),
    );

    it.live("answers a request without an id with a null-id envelope", () =>
      withHelper((helper) =>
        // A valid request the helper refuses on its parameters, before it
        // would touch the desktop.
        Effect.map(
          helper.exchange('{"jsonrpc":"2.0","method":"set-text","params":{}}\n'),
          (reply) => expectErrorReply(reply, null, PROTOCOL_MISMATCH_ERROR),
        ),
      ),
    );

    it.live("answers an unknown method with an error carrying the request id", () =>
      withHelper((helper) =>
        Effect.map(
          helper.exchange('{"jsonrpc":"2.0","id":7,"method":"no-such-method"}\n'),
          (reply) => expectErrorReply(reply, 7),
        ),
      ),
    );

    it.live("answers probe with the protocol and why the bus is unreachable", () =>
      withHelper((helper) =>
        Effect.map(helper.exchange('{"jsonrpc":"2.0","id":8,"method":"probe"}\n'), (reply) => {
          expect(reply).toMatchObject({
            jsonrpc: "2.0",
            id: 8,
            result: { ok: true, protocol: 2, atspi: false },
          });
          expect(typeof (reply as { result: { reason: unknown } }).result.reason).toBe("string");
        }),
      ),
    );
  });

  // libatspi aborted the process (dbind-ERROR, SIGABRT, a core dump) on the
  // first tree read against a bus that was not there. The helper must answer
  // instead, every time, and stay alive for the next request.
  describe.skipIf(!hasGi)("with no accessibility bus", () => {
    it.live("fails a tree read with a bus-unavailable error and keeps running", () =>
      withHelper((helper) =>
        Effect.forEach([11, 12], (id) =>
          Effect.map(helper.exchange(readTreeLine(id)), (reply) =>
            expectErrorReply(reply, id, BUS_UNAVAILABLE_ERROR),
          ),
        ),
      ),
    );

    it.live.skipIf(!hasDbusDaemon)(
      "reports a session bus without org.a11y.Bus as unavailable",
      () =>
        Effect.acquireUseRelease(
          Effect.sync(startPrivateSessionBus),
          (bus) =>
            withHelper(
              (helper) =>
                Effect.gen(function* () {
                  const probe = yield* helper.exchange(
                    '{"jsonrpc":"2.0","id":21,"method":"probe"}\n',
                  );
                  expect(probe).toMatchObject({ id: 21, result: { atspi: false } });
                  expect((probe as { result: { reason: string } }).result.reason).toMatch(
                    /org\.a11y\.Bus/,
                  );
                  expectErrorReply(
                    yield* helper.exchange(readTreeLine(22)),
                    22,
                    BUS_UNAVAILABLE_ERROR,
                  );
                }),
              {
                ...HELPER_ENV,
                AT_SPI_BUS_ADDRESS: undefined,
                DBUS_SESSION_BUS_ADDRESS: bus.address,
              },
            ),
          (bus) => Effect.sync(bus.stop),
        ),
    );
  });
});

function readTreeLine(id: number): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "read-tree",
    params: { protocol: 2, windows: [{ id: "w", title: "Editor", pid: 1 }] },
  })}\n`;
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** A throwaway session bus with no service activation, so nothing answers org.a11y.Bus. */
function startPrivateSessionBus(): { readonly address: string; readonly stop: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "pathway-atspi-bus-"));
  const config = join(directory, "session.conf");
  writeFileSync(
    config,
    [
      '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
      ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
      "<busconfig><type>session</type>",
      `<listen>unix:dir=${directory}</listen>`,
      '<policy context="default"><allow send_destination="*" eavesdrop="true"/>',
      '<allow eavesdrop="true"/><allow own="*"/></policy>',
      "</busconfig>",
    ].join("\n"),
  );
  const daemon = spawnSync(
    "dbus-daemon",
    ["--config-file", config, "--fork", "--print-address=1", "--print-pid=1"],
    { encoding: "utf8", timeout: 10_000 },
  );
  const [address, pid] = daemon.stdout.trim().split("\n");
  if (daemon.status !== 0 || !address || !pid) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`dbus-daemon did not start: ${daemon.stderr}`);
  }
  return {
    address,
    stop: () => {
      try {
        // The pid dbus-daemon printed for the bus this test started.
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // Already gone.
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function expectErrorReply(reply: unknown, id: number | null, code = -32000): void {
  expect(reply).toMatchObject({ jsonrpc: "2.0", id, error: { code } });
  expect(typeof (reply as { error: { message: unknown } }).error.message).toBe("string");
  expect(reply).not.toHaveProperty("result");
}

interface HelperSession {
  /** Writes one line and returns the next reply line, parsed. */
  readonly exchange: (line: string | Uint8Array) => Effect.Effect<unknown>;
}

/**
 * Runs `body` against a fresh helper, then proves the helper survived it: a
 * final probe must be answered by the very next line, which also shows the
 * exchange before it produced exactly one reply and nothing trailing.
 */
function withHelper<A>(
  body: (helper: HelperSession) => Effect.Effect<A>,
  env: Record<string, string | undefined> = HELPER_ENV,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const lines = yield* Queue.unbounded<string, Cause.Done>();
    const child = yield* spawner.spawn(
      ChildProcess.make(PYTHON, ["-u", HELPER_PATH], {
        env: definedEnv(env),
        extendEnv: false,
      }),
    );
    yield* Effect.forkScoped(Stream.run(Stream.fromQueue(input), child.stdin));
    yield* Effect.forkScoped(
      child.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) => Queue.offer(lines, line)),
        Effect.ensuring(Queue.end(lines)),
      ),
    );
    const stderr = yield* Effect.forkScoped(Stream.mkString(Stream.decodeText(child.stderr)));
    const helper: HelperSession = {
      exchange: (line) =>
        Queue.offer(input, typeof line === "string" ? new TextEncoder().encode(line) : line).pipe(
          Effect.andThen(Queue.take(lines)),
          Effect.timeout(REPLY_TIMEOUT),
          Effect.map((reply) => JSON.parse(reply) as unknown),
          Effect.catchCause((cause) =>
            Effect.flatMap(
              Fiber.join(stderr).pipe(Effect.timeout("1 second"), Effect.option),
              (tail) =>
                Effect.die(
                  new Error(
                    `No reply from the AT-SPI helper: ${Cause.pretty(cause)}\n${tail._tag === "Some" ? tail.value : ""}`,
                  ),
                ),
            ),
          ),
        ),
    };
    yield* body(helper);
    const reply = yield* helper.exchange('{"jsonrpc":"2.0","id":99,"method":"probe"}\n');
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 99, result: { ok: true } });
    expect(yield* child.isRunning).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.orDie);
}
