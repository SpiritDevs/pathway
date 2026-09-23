import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { COMPUTER_CONTROL_STATE_FILE, makeComputerControlState } from "./ComputerControlState.ts";

it.layer(NodeServices.layer)("ComputerControlState", (it) => {
  it.effect("serializes concurrent control writes per thread in call order", () =>
    Effect.gen(function* () {
      // Queued-dispatch and edit-resend admissions race through admitControl for
      // the same thread. Without serialization their read-modify-write sequences
      // interleave and concurrent revocations lose increments (last-writer-wins).
      const state = yield* makeComputerControlState(undefined);
      yield* Effect.all([state.set("thread", true), state.set("thread", true)], {
        concurrency: "unbounded",
      });
      expect(state.get("thread")).toMatchObject({ disabled: true, generation: 2 });
    }),
  );

  it.effect("applies a racing chat intent against the serialized generation", () =>
    Effect.gen(function* () {
      const state = yield* makeComputerControlState(undefined);
      yield* Effect.all([state.recordChatIntent("thread", true, 0), state.set("thread", true)], {
        concurrency: "unbounded",
      });
      // Call order wins: the intent recorded at generation 0, then the disable
      // bumped the generation and dropped it. A stale intent never survives a
      // concurrent revocation.
      expect(state.get("thread")).toMatchObject({ disabled: true, generation: 1 });
      expect(state.get("thread").chatGeneration).toBeUndefined();
    }),
  );

  describe("durable file", () => {
    it.effect("restores generations and chat intent from the state directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const state = yield* makeComputerControlState(dir);
        yield* state.set("thread", true);
        yield* state.set("thread", false);
        yield* state.recordChatIntent("thread", true, 1);
        const restored = yield* makeComputerControlState(dir);
        expect(restored.get("thread")).toEqual({
          disabled: false,
          generation: 1,
          chatGeneration: 1,
        });
        expect(restored.allows("thread", 0)).toBe(false);
        expect(restored.allows("thread", 1)).toBe(true);
      }),
    );

    it.effect("a malformed saved consent file disables Computer instead of failing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(dir, COMPUTER_CONTROL_STATE_FILE), "{not json");
        const state = yield* makeComputerControlState(dir);
        expect(state.get("thread")).toEqual({ disabled: true, generation: 0 });
        expect(state.allows("thread", 0)).toBe(false);
        expect((yield* Effect.flip(state.set("thread", false)))._tag).toBe(
          "ComputerControlStateError",
        );
        expect((yield* Effect.flip(state.recordChatIntent("thread", true, 0)))._tag).toBe(
          "ComputerControlStateError",
        );
        yield* state.recordChatIntent("thread", false, 0);
      }),
    );

    it.effect("a failed chat-intent write rolls the intent back", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const state = yield* makeComputerControlState(dir);
        // A directory at the temp path makes the atomic write fail.
        yield* fs.makeDirectory(path.join(dir, `${COMPUTER_CONTROL_STATE_FILE}.tmp`));
        const error = yield* Effect.flip(state.recordChatIntent("thread", true, 0));
        expect(error.message).toBe("Computer authorization state could not be saved.");
        expect(state.get("thread").chatGeneration).toBeUndefined();
      }),
    );

    it.effect("enabling an already enabled thread writes nothing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const state = yield* makeComputerControlState(dir);
        yield* state.set("thread", false);
        expect(yield* fs.exists(path.join(dir, COMPUTER_CONTROL_STATE_FILE))).toBe(false);
      }),
    );
  });
});
