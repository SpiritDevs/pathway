import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import { COMPUTER_CONTROL_STATE_FILE, makeComputerControlState } from "./ComputerControlState.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

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

    it.effect("an interrupted chat-intent write rolls the intent back", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const writing = yield* Deferred.make<void>();
        const state = yield* makeComputerControlState(dir).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: () =>
              Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        );
        const save = yield* Effect.forkChild(state.recordChatIntent("thread", true, 0));
        yield* Deferred.await(writing);
        yield* Fiber.interrupt(save);
        expect(state.get("thread").chatGeneration).toBeUndefined();
      }),
    );

    it.effect("an interrupted disable still reaches disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const gate = yield* gatedWrites(fs);
        const state = yield* makeComputerControlState(dir).pipe(
          Effect.provideService(FileSystem.FileSystem, gate.fs),
        );
        const save = yield* Effect.forkChild(state.set("thread", true));
        yield* Deferred.await(gate.writing);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(save));
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(interrupting);
        expect((yield* makeComputerControlState(dir)).get("thread")).toEqual({
          disabled: true,
          generation: 1,
        });
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

it.layer(NodeServices.layer)("durable Computer activation", (it) => {
  it.effect(
    "rejects frozen local and server queue generations after disable, re-enable and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped();
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            stateDir: dir,
          });
          expect(manager.canActivateControl("thread", 0)).toBe(true);
          expect(yield* manager.setControlEnabled("thread", false)).toEqual({
            enabled: false,
            generation: 1,
          });
          expect(manager.canActivateControl("thread", 1)).toBe(false);
          expect(yield* manager.setControlEnabled("thread", true)).toEqual({
            enabled: true,
            generation: 1,
          });
          expect(manager.canActivateControl("thread", 0)).toBe(false);
          expect(manager.canActivateControl("thread", 1)).toBe(true);
          const restored = yield* makeComputerControlState(dir);
          expect(restored.allows("thread", 0)).toBe(false);
          expect(restored.allows("thread", 1)).toBe(true);
          yield* manager.setControlEnabled("thread", false);
          expect((yield* makeComputerControlState(dir)).allows("thread", 2)).toBe(false);
        }),
      ),
  );

  it.effect(
    "increments revocation synchronously and does not let overlapping enable undo a later disable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({ backend: new FakeComputerBackend() });
          const firstDisable = yield* manager
            .setControlEnabled("thread", false)
            .pipe(Effect.forkChild({ startImmediately: true }));
          expect(manager.canActivateControl("thread", 0)).toBe(false);
          const enable = yield* manager
            .setControlEnabled("thread", true)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const lastDisable = yield* manager
            .setControlEnabled("thread", false)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.joinAll([firstDisable, enable, lastDisable]);
          expect(manager.canActivateControl("thread", 2)).toBe(false);
          expect(yield* manager.setControlEnabled("thread", true)).toEqual({
            enabled: true,
            generation: 2,
          });
          expect(manager.canActivateControl("thread", 1)).toBe(false);
        }),
      ),
  );

  it.effect("a disable still writing when the manager shuts down reaches disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const gate = yield* gatedWrites(fs);
      const scope = yield* Scope.make();
      const manager = yield* ComputerManager.make({
        backend: new FakeComputerBackend(),
        stateDir: dir,
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(FileSystem.FileSystem, gate.fs),
      );
      yield* manager
        .setControlEnabled("thread", false)
        .pipe(Effect.ignore, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(gate.writing);
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(closing);
      expect((yield* makeComputerControlState(dir)).allows("thread", 0)).toBe(false);
    }),
  );

  it.effect("keeps authority closed if durable preference writes fail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const blockedParent = path.join(dir, "blocked");
        const manager = yield* ComputerManager.make({
          backend: new FakeComputerBackend(),
          stateDir: blockedParent,
        });
        yield* fs.writeFileString(blockedParent, "not a directory");
        yield* Effect.flip(manager.setControlEnabled("thread", false));
        expect(manager.canActivateControl("thread", 0)).toBe(false);
        yield* Effect.flip(manager.setControlEnabled("thread", true));
        expect(manager.canActivateControl("thread", 1)).toBe(false);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("Computer control consent", (it) => {
  it.effect(
    "a malformed saved consent file disables Computer without breaking ordinary startup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped();
          yield* fs.writeFileString(path.join(dir, COMPUTER_CONTROL_STATE_FILE), "{broken");
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            stateDir: dir,
          });
          expect(manager.canActivateControl("thread", 0)).toBe(false);
          expect((yield* Effect.flip(manager.setControlEnabled("thread", true))).message).toContain(
            "could not be loaded",
          );
          expect(
            (yield* Effect.flip(manager.withAgentActivity("thread", Effect.void))).message,
          ).toContain("revoked");
        }),
      ),
  );

  it.effect(
    "persists only explicit matching-generation chat intent and clears it on background request, off and disable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped();
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            stateDir: dir,
          });
          expect(yield* manager.admitControl("thread", "request", 0)).toBe(true);
          expect(manager.canContinueChatControl("thread")).toBe(false);
          expect(yield* manager.admitControl("thread", "chat", 0)).toBe(true);
          expect(manager.canContinueChatControl("thread")).toBe(true);
          expect((yield* makeComputerControlState(dir)).get("thread").chatGeneration).toBe(0);
          expect(manager.canContinueChatControl("other-thread")).toBe(false);
          yield* manager.admitControl("thread", "off", 0);
          expect(manager.canContinueChatControl("thread")).toBe(false);
          yield* manager.admitControl("thread", "chat", 0);
          yield* manager.setControlEnabled("thread", false);
          yield* manager.setControlEnabled("thread", true);
          expect(manager.canContinueChatControl("thread")).toBe(false);
          expect(yield* manager.admitControl("thread", "chat", 0)).toBe(false);
          expect(manager.canContinueChatControl("thread")).toBe(false);
          expect(yield* manager.admitControl("thread", "chat", 1)).toBe(true);
          expect((yield* makeComputerControlState(dir)).get("thread").chatGeneration).toBe(1);
        }),
      ),
  );

  it.effect(
    "one-shot requests never persist chat consent, including after a previous chat opt-in",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped();
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            stateDir: dir,
          });
          expect(yield* manager.admitControl("thread", "chat", 0)).toBe(true);
          expect(manager.canContinueChatControl("thread")).toBe(true);
          for (const explicitInvocation of [false, true, true]) {
            expect(yield* manager.admitControl("thread", "request", 0, explicitInvocation)).toBe(
              true,
            );
            expect(manager.canContinueChatControl("thread")).toBe(false);
            expect(
              (yield* makeComputerControlState(dir)).get("thread").chatGeneration,
            ).toBeUndefined();
          }
          yield* manager.admitControl("thread", "off", 0);
          expect(manager.canContinueChatControl("thread")).toBe(false);
        }),
      ),
  );

  it.effect("ordinary off admission does not create a consent file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const manager = yield* ComputerManager.make({
          backend: new FakeComputerBackend(),
          stateDir: dir,
        });
        expect(yield* manager.admitControl("thread", "off", 0)).toBe(false);
        expect(yield* manager.admitControl("thread", "off", 0)).toBe(false);
        expect(yield* fs.exists(path.join(dir, COMPUTER_CONTROL_STATE_FILE))).toBe(false);
      }),
    ),
  );

  it.effect("failed chat-intent persistence cannot authorize a later goal after re-enable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const blocked = path.join(dir, "blocked");
        const manager = yield* ComputerManager.make({
          backend: new FakeComputerBackend(),
          stateDir: blocked,
        });
        yield* fs.writeFileString(blocked, "not a directory");
        yield* Effect.flip(manager.admitControl("thread", "chat", 0));
        expect(manager.canContinueChatControl("thread")).toBe(false);
        yield* fs.remove(blocked);
        yield* manager.setControlEnabled("thread", true);
        expect(manager.canContinueChatControl("thread")).toBe(false);
      }),
    ),
  );
});

/** A file system whose next writes wait until the test releases them. */
const gatedWrites = Effect.fnUntraced(function* (fs: FileSystem.FileSystem) {
  const writing = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const gated: FileSystem.FileSystem = {
    ...fs,
    writeFileString: (path, data, options) =>
      Deferred.succeed(writing, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(fs.writeFileString(path, data, options)),
      ),
  };
  return { fs: gated, writing, release };
});
