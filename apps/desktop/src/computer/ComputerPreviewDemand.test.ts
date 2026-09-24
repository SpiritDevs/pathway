// @effect-diagnostics nodeBuiltinImport:off -- The test plays the helper's side of the real Unix frame socket.
// Native capture follows the renderer's preview subscriptions: the preload
// bridge reports demand, the IPC call reaches the real frame tap, and the fake
// helper spawner stands in for pathway-helper.
import * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import * as IpcChannels from "../ipc/channels.ts";
import { type ComputerFrameTap, make } from "./ComputerFrameTap.ts";
import { createComputerPreloadBridge } from "./ComputerPreloadBridge.ts";
import { type FakeHelper, makeFakeHelperSpawner } from "./testing/FakeHelperSpawner.ts";

const ipc = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    tap: undefined as ComputerFrameTap | undefined,
    // The last demand the main process is still applying.
    demand: Promise.resolve() as Promise<void>,
    listeners,
    invoke: (channel: string, watched: unknown) => {
      if (channel === "desktop:computer-preview-watched" && ipc.tap) {
        ipc.demand = Effect.runPromise(ipc.tap.setWatched(watched === true));
      }
      return ipc.demand;
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    },
    emit: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
  };
});
vi.mock("electron", () => ({ ipcRenderer: ipc }));

const connect = (helper: FakeHelper) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Socket>((resume) => {
      const socket = NodeNet.createConnection(helper.args[helper.args.indexOf("--out") + 1]!, () =>
        resume(Effect.succeed(socket)),
      );
      socket.on("error", () => undefined);
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );

const writeFrame = (socket: NodeNet.Socket) =>
  Effect.callback<void>((resume) => {
    const payload = Buffer.from([0xff, 0xd8, 1]);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    socket.write(Buffer.concat([header, payload]), () => resume(Effect.void));
  });

it.live("native capture stops when the last preview unsubscribes and resumes on reopen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* makeFakeHelperSpawner;
      const sent = yield* Queue.unbounded<number>();
      ipc.tap = yield* make({
        helperPath: "/fixture/pathway-helper",
        send: (channel, frame) =>
          Effect.sync(() => ipc.emit(channel, frame)).pipe(
            Effect.andThen(Queue.offer(sent, frame.seq)),
            Effect.asVoid,
          ),
        onError: () => Effect.void,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer));
      const bridge = createComputerPreloadBridge();
      yield* Effect.promise(() => ipc.demand);

      // Nobody watches yet, so the agent's target starts no capture.
      yield* ipc.tap.update({
        task: { threadId: "thread-a", turnId: "turn-a" },
        pid: 7,
        windowId: 42,
      });
      assert.strictEqual(fake.spawned.length, 0);

      let drawn = 0;
      const unsubscribe = bridge.onPreviewFrame(() => {
        drawn++;
      });
      yield* Effect.promise(() => ipc.demand);
      const helper = yield* fake.next;
      yield* writeFrame(yield* connect(helper));
      yield* Queue.take(sent);
      assert.strictEqual(drawn, 1);

      // The unsubscribe useComputerPreviewTap runs on hide, thread change and unmount.
      unsubscribe();
      yield* Effect.promise(() => ipc.demand);
      assert.deepStrictEqual(helper.signals, ["SIGTERM"]);
      assert.strictEqual(ipc.listeners.get(IpcChannels.COMPUTER_PREVIEW_FRAME_CHANNEL)?.size, 0);

      bridge.onPreviewFrame(() => {
        drawn++;
      });
      yield* Effect.promise(() => ipc.demand);
      const resumed = yield* fake.next;
      assert.include(resumed.args, "42");
      yield* writeFrame(yield* connect(resumed));
      yield* Queue.take(sent);
      assert.strictEqual(drawn, 2);
    }),
  ),
);
