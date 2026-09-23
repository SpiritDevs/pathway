// @effect-diagnostics nodeBuiltinImport:off -- The test plays the helper's side of the real Unix frame socket.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CuaPreviewTarget } from "@spiritdevs/shared/cuaDriverProtocol";

import {
  COMPUTER_PREVIEW_FRAME_CHANNEL,
  type ComputerFrameTap,
  type ComputerPreviewFrame,
  make,
} from "./ComputerFrameTap.ts";
import {
  type FakeHelper,
  type FakeHelperSpawner,
  makeFakeHelperSpawner,
} from "./testing/FakeHelperSpawner.ts";

const TASK = { threadId: "thread-1", turnId: "turn-1" };
const TARGET: CuaPreviewTarget = { task: TASK, pid: 7, windowId: 42 };

interface Harness {
  readonly tap: ComputerFrameTap;
  readonly fake: FakeHelperSpawner;
  readonly frames: Queue.Queue<{ channel: string; frame: ComputerPreviewFrame }>;
  readonly errors: Queue.Queue<unknown>;
}

const withTap = <A, E>(body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeHelperSpawner;
    const frames = yield* Queue.unbounded<{ channel: string; frame: ComputerPreviewFrame }>();
    const errors = yield* Queue.unbounded<unknown>();
    const scope = yield* Scope.make();
    const tap = yield* make({
      helperPath: "/fixture/pathway-helper",
      send: (channel, frame) => Queue.offer(frames, { channel, frame }).pipe(Effect.asVoid),
      onError: (error) => Queue.offer(errors, error).pipe(Effect.asVoid),
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
    );
    return yield* body({ tap, fake, frames, errors }).pipe(
      Effect.scoped,
      Effect.ensuring(Scope.close(scope, Exit.void)),
    );
  });

const socketPathOf = (helper: FakeHelper) => helper.args[helper.args.indexOf("--out") + 1]!;

/** Connects to the tap's socket the way the helper does. */
const connect = (helper: FakeHelper) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Socket>((resume) => {
      const socket = NodeNet.createConnection(socketPathOf(helper), () =>
        resume(Effect.succeed(socket)),
      );
      socket.on("error", () => undefined);
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );

const write = (socket: NodeNet.Socket, bytes: Uint8Array) =>
  Effect.callback<void>((resume) => {
    socket.write(bytes, () => resume(Effect.void));
  });

const lengthPrefix = (length: number) => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(length, 0);
  return header;
};

const framed = (...jpegs: ReadonlyArray<Uint8Array>) =>
  Buffer.concat(jpegs.flatMap((jpeg) => [lengthPrefix(jpeg.length), jpeg]));

const bytes = (...values: ReadonlyArray<number>) => Uint8Array.from(values);

/** A dead target is ignored by `update`, so `stop` settles with no new spawn. */
const assertNoRespawn = (harness: Harness, target: CuaPreviewTarget) =>
  Effect.gen(function* () {
    const before = harness.fake.spawned.length;
    yield* harness.tap.update(target);
    yield* harness.tap.stop;
    assert.strictEqual(harness.fake.spawned.length, before);
  });

describe("ComputerFrameTap", () => {
  it.effect("spawns the frames helper against a private socket", () =>
    withTap(({ tap, fake }) =>
      Effect.gen(function* () {
        yield* tap.update(TARGET);
        const helper = yield* fake.next;
        const socketPath = socketPathOf(helper);
        assert.deepStrictEqual(helper.args, [
          "--computer-frames",
          "--window-id",
          "42",
          "--pid",
          "7",
          "--out",
          socketPath,
        ]);
        const directory = NodePath.dirname(socketPath);
        assert.match(NodePath.basename(directory), /^pathway-frames-/);
        assert.match(NodePath.basename(socketPath), /^tap-[0-9a-f]{8}\.sock$/);
        assert.strictEqual(NodeFS.statSync(directory).mode & 0o777, 0o700);
        assert.strictEqual(NodeFS.statSync(socketPath).mode & 0o777, 0o600);
      }),
    ),
  );

  it.effect("delivers length-prefixed frames split across and packed into chunks", () =>
    withTap(({ tap, fake, frames }) =>
      Effect.gen(function* () {
        yield* tap.update(TARGET);
        const socket = yield* connect(yield* fake.next);
        const payload = framed(bytes(0xff, 0xd8, 1), bytes(0xff, 0xd8, 2, 2), bytes(3));
        // The first frame arrives in two pieces; the other two share a chunk.
        yield* write(socket, payload.subarray(0, 5));
        yield* write(socket, payload.subarray(5));
        const received = [yield* Queue.take(frames), yield* Queue.take(frames)];
        received.push(yield* Queue.take(frames));
        assert.deepStrictEqual(
          received.map(({ channel, frame }) => [
            channel,
            frame.windowId,
            frame.seq,
            [...frame.jpeg],
          ]),
          [
            [COMPUTER_PREVIEW_FRAME_CHANNEL, 42, 1, [0xff, 0xd8, 1]],
            [COMPUTER_PREVIEW_FRAME_CHANNEL, 42, 2, [0xff, 0xd8, 2, 2]],
            [COMPUTER_PREVIEW_FRAME_CHANNEL, 42, 3, [3]],
          ],
        );
      }),
    ),
  );

  it.effect("a zero-length frame is malformed and kills the tap for its target", () =>
    withTap((harness) =>
      Effect.gen(function* () {
        const { tap, fake, frames, errors } = harness;
        yield* tap.update(TARGET);
        const helper = yield* fake.next;
        const socket = yield* connect(helper);
        yield* write(socket, Buffer.concat([framed(bytes(9)), lengthPrefix(0)]));
        assert.deepStrictEqual([...(yield* Queue.take(frames)).frame.jpeg], [9]);
        const error = (yield* Queue.take(errors)) as { reason: string };
        assert.strictEqual(error.reason, "malformed-frame");
        yield* tap.stop;
        assert.deepStrictEqual(helper.signals, ["SIGTERM"]);
        yield* assertNoRespawn(harness, TARGET);
      }),
    ),
  );

  it.effect("a frame over 4MB is malformed and kills the tap", () =>
    withTap((harness) =>
      Effect.gen(function* () {
        const { tap, fake, errors } = harness;
        yield* tap.update(TARGET);
        const helper = yield* fake.next;
        const socket = yield* connect(helper);
        // Only the header is needed: the length alone condemns the frame.
        yield* write(socket, lengthPrefix(4 * 1024 * 1024 + 1));
        const error = (yield* Queue.take(errors)) as { reason: string };
        assert.strictEqual(error.reason, "malformed-frame");
        yield* tap.stop;
        assert.deepStrictEqual(helper.signals, ["SIGTERM"]);
        yield* assertNoRespawn(harness, TARGET);
      }),
    ),
  );

  it.effect("a helper error line kills the tap", () =>
    withTap((harness) =>
      Effect.gen(function* () {
        const { tap, fake, errors } = harness;
        yield* tap.update(TARGET);
        const helper = yield* fake.next;
        yield* helper.emit({ type: "error", code: "window_gone" });
        const error = (yield* Queue.take(errors)) as { reason: string; message: string };
        assert.strictEqual(error.reason, "capture-failed");
        assert.include(error.message, "window_gone");
        yield* tap.stop;
        assert.deepStrictEqual(helper.signals, ["SIGTERM"]);
        yield* assertNoRespawn(harness, TARGET);
      }),
    ),
  );

  it.effect("an unexpected helper exit poisons only that target", () =>
    withTap((harness) =>
      Effect.gen(function* () {
        const { tap, fake, errors } = harness;
        yield* tap.update(TARGET);
        const helper = yield* fake.next;
        yield* helper.exit(1);
        const error = (yield* Queue.take(errors)) as { reason: string; message: string };
        assert.strictEqual(error.reason, "helper-exited");
        assert.include(error.message, "code 1");
        yield* tap.stop;
        yield* assertNoRespawn(harness, TARGET);
        // Another window of the same task is a different target.
        yield* tap.update({ ...TARGET, windowId: 43 });
        const next = yield* fake.next;
        assert.include(next.args, "43");
      }),
    ),
  );

  it.effect("retargeting retires the old tap with stopHelper; the same target keeps it", () =>
    withTap(({ tap, fake }) =>
      Effect.gen(function* () {
        yield* tap.update(TARGET);
        const first = yield* fake.next;
        // Same key (task, pid, window): only the cursor moved.
        yield* tap.update({ ...TARGET, cursor: { x: 1, y: 2 } });
        yield* tap.update({ ...TARGET, windowId: 43 });
        const second = yield* fake.next;
        assert.deepStrictEqual(first.signals, ["SIGTERM"]);
        assert.isFalse(NodeFS.existsSync(socketPathOf(first)));
        assert.include(second.args, "43");
        assert.strictEqual(fake.spawned.length, 2);
      }),
    ),
  );

  it.effect("stop retires the tap and removes its socket", () =>
    withTap(({ tap, fake }) =>
      Effect.gen(function* () {
        yield* tap.update(TARGET);
        const helper = yield* fake.next;
        yield* tap.stop;
        assert.deepStrictEqual(helper.signals, ["SIGTERM"]);
        assert.isFalse(NodeFS.existsSync(socketPathOf(helper)));
      }),
    ),
  );

  it.effect("endTask clears the dead-target memo by prefix so the task can respawn", () =>
    withTap((harness) =>
      Effect.gen(function* () {
        const { tap, fake, errors } = harness;
        /** Kills the live tap and waits until the tap has noticed. */
        const crash = Effect.gen(function* () {
          yield* (yield* fake.next).exit(1);
          yield* Queue.take(errors);
          yield* tap.stop;
        });
        const otherTurn: CuaPreviewTarget = {
          ...TARGET,
          task: { threadId: "thread-1", turnId: "turn-2" },
        };
        const otherThread: CuaPreviewTarget = { ...TARGET, task: { threadId: "thread-10" } };
        for (const target of [TARGET, otherTurn, otherThread]) {
          yield* tap.update(target);
          yield* crash;
          yield* assertNoRespawn(harness, target);
        }
        // A turn end forgets only that turn.
        yield* tap.endTask(TASK);
        yield* assertNoRespawn(harness, otherTurn);
        yield* tap.update(TARGET);
        yield* crash;
        // A thread end forgets every turn of that thread, and no other thread.
        yield* tap.endTask({ threadId: "thread-1" });
        yield* assertNoRespawn(harness, otherThread);
        yield* tap.update(otherTurn);
        const respawned = yield* fake.next;
        assert.deepStrictEqual(respawned.args.slice(0, 5), [
          "--computer-frames",
          "--window-id",
          "42",
          "--pid",
          "7",
        ]);
      }),
    ),
  );

  it.effect("endTask of another task leaves the live tap alone", () =>
    withTap(({ tap, fake }) =>
      Effect.gen(function* () {
        yield* tap.update(TARGET);
        const helper = yield* fake.next;
        yield* tap.endTask({ threadId: "thread-2" });
        yield* tap.endTask({ threadId: "thread-1", turnId: "turn-9" });
        assert.deepStrictEqual(helper.signals, []);
        yield* tap.endTask({ threadId: "thread-1" });
        assert.deepStrictEqual(helper.signals, ["SIGTERM"]);
      }),
    ),
  );

  it.effect("dispose retires the tap and removes the socket directory", () =>
    withTap(({ tap, fake }) =>
      Effect.gen(function* () {
        yield* tap.update(TARGET);
        const helper = yield* fake.next;
        const directory = NodePath.dirname(socketPathOf(helper));
        yield* tap.dispose;
        assert.deepStrictEqual(helper.signals, ["SIGTERM"]);
        assert.isFalse(NodeFS.existsSync(directory));
      }),
    ),
  );
});
