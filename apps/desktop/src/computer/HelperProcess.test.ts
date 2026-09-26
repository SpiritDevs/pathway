import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type HelperExit, spawnHelper, stopHelper } from "./HelperProcess.ts";
import { parsePathwayHelperMessage } from "./PathwayHelperProtocol.ts";
import { makeFakeHelperSpawner } from "./testing/FakeHelperSpawner.ts";

const withFake = <A, E>(
  body: (
    fake: Effect.Success<typeof makeFakeHelperSpawner>,
    scope: Scope.Scope,
  ) => Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeHelperSpawner;
    const scope = yield* Scope.make();
    return yield* body(fake, scope).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
      Effect.ensuring(Scope.close(scope, Exit.void)),
    );
  });

describe("pathway-helper protocol", () => {
  it.effect("accepts typed permission messages", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        parsePathwayHelperMessage(
          '{"type":"permissions","inputMonitoring":"granted","screenRecording":"denied"}',
        ),
        { type: "permissions", inputMonitoring: "granted", screenRecording: "denied" },
      );
      assert.deepStrictEqual(
        parsePathwayHelperMessage(
          '{"type":"physical-input","kind":"pointer","pid":42,"windowId":0,"capturedAt":"now"}',
        ),
        { type: "physical-input", kind: "pointer", pid: 42, capturedAt: "now" },
      );
      assert.deepStrictEqual(
        parsePathwayHelperMessage('{"type":"release-held-input","released":true}'),
        { type: "release-held-input", released: true },
      );
    }),
  );

  it.effect("rejects malformed or unknown helper output", () =>
    Effect.sync(() => {
      assert.isNull(parsePathwayHelperMessage("not-json"));
      assert.isNull(parsePathwayHelperMessage('{"type":"permissions"}'));
      assert.isNull(parsePathwayHelperMessage('{"type":"error","code":"x"}'));
      assert.isNull(parsePathwayHelperMessage('{"type":"captured","path":"/tmp/x"}'));
      assert.isNull(parsePathwayHelperMessage('{"type":"surprise"}'));
    }),
  );
});

describe("helper processes", () => {
  it.effect("delivers stdout lines in order and reports the exit after they drain", () =>
    withFake((fake, scope) =>
      Effect.gen(function* () {
        const lines: Array<string> = [];
        const exits: Array<HelperExit> = [];
        const helper = yield* spawnHelper(scope, {
          command: "/helper",
          args: ["--escape-monitor"],
          onStdoutLine: (line) => Effect.sync(() => lines.push(line)),
          onExit: (exit) => Effect.sync(() => exits.push(exit)),
        });
        const process = yield* fake.next;
        assert.deepStrictEqual(process.args, ["--escape-monitor"]);
        yield* process.emit("first");
        yield* process.emit("second");
        yield* process.exit(3);
        assert.deepStrictEqual(yield* helper.exited, { code: 3 });
        assert.deepStrictEqual(lines, ["first", "second"]);
        assert.deepStrictEqual(exits, [{ code: 3 }]);
        assert.isTrue(yield* helper.hasExited);
      }),
    ),
  );

  it.effect("writes stdin lines and closes stdin as EOF", () =>
    withFake((fake, scope) =>
      Effect.gen(function* () {
        const helper = yield* spawnHelper(scope, { command: "/helper", args: [], stdin: true });
        const process = yield* fake.next;
        assert.isTrue(yield* helper.writeLine("arm"));
        yield* process.awaitStdin("arm");
        yield* helper.endInput;
        assert.isFalse(yield* helper.writeLine("disarm"));
        yield* process.exit(0);
        yield* helper.exited;
        assert.deepStrictEqual(process.stdinLines, ["arm"]);
        assert.isTrue(process.stdinEnded());
      }),
    ),
  );

  it.effect("keeps only the bounded head of stderr", () =>
    withFake((fake, scope) =>
      Effect.gen(function* () {
        const helper = yield* spawnHelper(scope, { command: "/helper", args: [], stderrLimit: 8 });
        const process = yield* fake.next;
        yield* process.emitStderr("abcdef\nghijkl\n");
        yield* process.exit(1);
        yield* helper.exited;
        assert.strictEqual(yield* helper.stderr, "abcdef\ng");
      }),
    ),
  );

  it.effect("escalates a helper that ignores SIGTERM, then fails if SIGKILL is ignored", () =>
    withFake((fake, scope) =>
      Effect.gen(function* () {
        const helper = yield* spawnHelper(scope, { command: "/helper", args: [] });
        const process = yield* fake.next;
        process.exitOnSignal = false;
        const stopping = yield* Effect.forkChild(Effect.flip(stopHelper(helper)));
        yield* TestClock.adjust(1_000);
        assert.deepStrictEqual(process.signals, ["SIGTERM", "SIGKILL"]);
        yield* TestClock.adjust(1_000);
        const error = yield* Fiber.join(stopping);
        assert.strictEqual(error._tag, "HelperStopError");
      }),
    ),
  );

  it.effect("returns once a signalled helper exits", () =>
    withFake((fake, scope) =>
      Effect.gen(function* () {
        const helper = yield* spawnHelper(scope, { command: "/helper", args: [] });
        const process = yield* fake.next;
        yield* stopHelper(helper);
        assert.deepStrictEqual(process.signals, ["SIGTERM"]);
        assert.deepStrictEqual(yield* helper.exited, { code: null });
      }),
    ),
  );

  it.effect("reports a spawn failure as a typed error", () =>
    withFake((fake, scope) =>
      Effect.gen(function* () {
        fake.failNextSpawn();
        const error = yield* Effect.flip(spawnHelper(scope, { command: "/missing", args: [] }));
        assert.strictEqual(error._tag, "HelperSpawnError");
      }),
    ),
  );

  it.effect("kills a still-running helper when its owner scope closes", () =>
    withFake((fake, _scope) =>
      Effect.gen(function* () {
        const owner = yield* Scope.make();
        const helper = yield* spawnHelper(owner, { command: "/helper", args: [] });
        const process = yield* fake.next;
        yield* Scope.close(owner, Exit.void);
        assert.isTrue(process.exitedFlag());
        assert.deepStrictEqual(process.signals, ["SIGTERM"]);
        assert.deepStrictEqual(yield* helper.exited, { code: null });
      }),
    ),
  );

  it.live("drives a real attached process through stdin and stdout", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const received = yield* Deferred.make<string>();
      const helper = yield* spawnHelper(scope, {
        command: "/bin/cat",
        args: [],
        stdin: true,
        onStdoutLine: (line) => Deferred.succeed(received, line).pipe(Effect.asVoid),
      });
      yield* helper.writeLine('{"type":"ready"}');
      assert.deepStrictEqual(parsePathwayHelperMessage(yield* Deferred.await(received)), {
        type: "ready",
      });
      yield* helper.endInput;
      assert.deepStrictEqual(yield* helper.exited, { code: 0 });
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
