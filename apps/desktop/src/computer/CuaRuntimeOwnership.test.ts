// @effect-diagnostics nodeBuiltinImport:off -- Tests build private runtime directories on the real filesystem.
// @effect-diagnostics globalDate:off -- Fixtures age real directories relative to wall-clock time.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import {
  cuaHostProcessIsAlive,
  markCuaRuntimeDirectory,
  sweepOwnedCuaRuntimeDirectories,
} from "./CuaRuntimeOwnership.ts";

const fs = NodeFS.promises;
const MarkerJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeMarker = Schema.decodeUnknownSync(MarkerJson);
const encodeMarker = Schema.encodeSync(MarkerJson);
const roots: string[] = [];
const old = Date.now() - 120_000;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const fixture = Effect.promise(async () => {
  const directory = await fs.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "pathway-runtime-ownership-test-"),
  );
  roots.push(directory);
  return directory;
});

const owned = (root: string, name = "pathway-cua-Ab123Z") =>
  Effect.gen(function* () {
    const directory = NodePath.join(root, name);
    yield* Effect.promise(() => fs.mkdir(directory, { mode: 0o700 }));
    yield* markCuaRuntimeDirectory(directory);
    const markerPath = NodePath.join(directory, ".pathway-cua-runtime.json");
    return yield* Effect.promise(async () => {
      const marker = decodeMarker(await fs.readFile(markerPath, "utf8"));
      await fs.writeFile(markerPath, encodeMarker({ ...marker, createdAt: old }));
      await fs.writeFile(NodePath.join(directory, "state"), "owned temporary state");
      await fs.utimes(directory, old / 1000, old / 1000);
      return { directory, markerPath, marker };
    });
  });

const sweep = (directory: string, liveSocketDirs: ReadonlySet<string> = new Set()) =>
  sweepOwnedCuaRuntimeDirectories({ directory, liveSocketDirs, isProcessAlive: () => false });

// oxlint-disable-next-line pathway/no-global-process-runtime -- Test collection skips the Unix ownership model on Windows.
describe.skipIf(process.platform === "win32")("owned Cua runtime cleanup", () => {
  it.live("never removes similarly named tools/evidence or an unmarked legacy runtime", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const names = ["pathway-cua-tools", "pathway-cua-native-work", "pathway-cua-Ab123Z"];
      yield* Effect.promise(async () => {
        for (const name of names) {
          const path = NodePath.join(root, name);
          await fs.mkdir(path, { mode: 0o700 });
          await fs.writeFile(NodePath.join(path, "important"), "preserve");
          await fs.utimes(path, old / 1000, old / 1000);
        }
      });
      assert.deepStrictEqual(yield* sweep(root), []);
      for (const name of names)
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(root, name, "important"), "utf8"),
          "preserve",
        );
    }),
  );

  it.live("protects a live lazy host even when it has never spawned a driver", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const runtime = yield* owned(root);
      assert.deepStrictEqual(
        yield* sweepOwnedCuaRuntimeDirectories({ directory: root, liveSocketDirs: new Set() }),
        [],
      );
      assert.isTrue(NodeFS.existsSync(runtime.directory));
    }),
  );

  it.live("removes only a marked private stale directory whose owner is confirmed dead", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const runtime = yield* owned(root);
      assert.deepStrictEqual(yield* sweep(root), ["pathway-cua-Ab123Z"]);
      assert.isFalse(NodeFS.existsSync(runtime.directory));
    }),
  );

  it.live("keeps the directory of a still-running driver even after its host died", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const runtime = yield* owned(root);
      assert.deepStrictEqual(yield* sweep(root, new Set([runtime.directory])), []);
      assert.isTrue(NodeFS.existsSync(runtime.directory));
    }),
  );

  it.live("never follows a runtime directory or ownership-marker symlink", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const external = NodePath.join(root, "preserved-evidence");
      yield* Effect.promise(async () => {
        await fs.mkdir(external, { mode: 0o700 });
        await fs.writeFile(NodePath.join(external, "important"), "preserve");
        await fs.symlink(external, NodePath.join(root, "pathway-cua-link99"));
      });
      const runtime = yield* owned(root);
      yield* Effect.promise(async () => {
        const marker = await fs.readFile(runtime.markerPath, "utf8");
        const externalMarker = NodePath.join(external, "marker.json");
        await fs.writeFile(externalMarker, marker, { mode: 0o600 });
        await fs.unlink(runtime.markerPath);
        await fs.symlink(externalMarker, runtime.markerPath);
        await fs.utimes(runtime.directory, old / 1000, old / 1000);
      });
      assert.deepStrictEqual(yield* sweep(root), []);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(external, "important"), "utf8"),
        "preserve",
      );
      assert.isTrue(NodeFS.existsSync(runtime.directory));
    }),
  );

  it.live.each([
    { ownerUid: (process.getuid?.() ?? 0) + 1 },
    { directory: "pathway-cua-Other1" },
    { schema: "some-other-application" },
    { hostPid: 0 },
    { hostPid: "123" },
    { createdAt: Date.now() },
  ])("preserves malformed, foreign, or newly created ownership %j", (override) =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const runtime = yield* owned(root);
      yield* Effect.promise(() =>
        fs.writeFile(
          runtime.markerPath,
          encodeMarker({ ...runtime.marker, createdAt: old, ...override }),
        ),
      );
      assert.deepStrictEqual(yield* sweep(root), []);
      assert.isTrue(NodeFS.existsSync(runtime.directory));
    }),
  );

  it.live("preserves a FIFO marker without waiting for a writer", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const runtime = yield* owned(root);
      yield* Effect.promise(async () => {
        await fs.unlink(runtime.markerPath);
        NodeChildProcess.execFileSync("mkfifo", [runtime.markerPath]);
        await fs.utimes(runtime.directory, old / 1000, old / 1000);
      });
      assert.deepStrictEqual(yield* sweep(root), []);
      assert.isTrue(NodeFS.existsSync(runtime.directory));
    }),
  );

  it.live("does not accept a marker writable by another user", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const runtime = yield* owned(root);
      yield* Effect.promise(() => fs.chmod(runtime.markerPath, 0o666));
      assert.deepStrictEqual(yield* sweep(root), []);
      assert.isTrue(NodeFS.existsSync(runtime.directory));
    }),
  );

  it.effect("treats inaccessible process ownership as alive rather than permission to delete", () =>
    Effect.sync(() => {
      const kill = vi.spyOn(process, "kill");
      kill.mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      });
      assert.isTrue(cuaHostProcessIsAlive(123));
      kill.mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      assert.isFalse(cuaHostProcessIsAlive(123));
    }),
  );
});
