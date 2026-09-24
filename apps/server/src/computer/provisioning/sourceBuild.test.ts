import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ComputerBackendError } from "../computerErrors.ts";
import { makeProcessWitness } from "./processWitness.testkit.ts";
import { buildPluginFromSource } from "./sourceBuild.ts";

/** A stand-in installer script; the real one is never run here. */
const fakeScript = (body: (directory: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-source-build-" });
    const scriptPath = path.join(directory, "install-and-load.sh");
    yield* fs.writeFileString(scriptPath, `#!/usr/bin/env bash\nset -eu\n${body(directory)}\n`, {
      mode: 0o755,
    });
    return { directory, scriptPath };
  });

describe("buildPluginFromSource", () => {
  it.live("passes --build-only and returns the last stdout line as the built path", () =>
    Effect.gen(function* () {
      const { scriptPath } = yield* fakeScript(
        () =>
          '[[ "$1" == "--build-only" ]] || exit 9\necho "[pathway-kwin-plugin] configuring"\necho "/tmp/build/kwin/plugins/PathwayComputerUsePlugin.so"',
      );
      expect(yield* buildPluginFromSource({ scriptPath })).toBe(
        "/tmp/build/kwin/plugins/PathwayComputerUsePlugin.so",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses an empty answer instead of installing nothing", () =>
    Effect.gen(function* () {
      const { scriptPath } = yield* fakeScript(() => "exit 0");
      const error = yield* Effect.flip(buildPluginFromSource({ scriptPath }));
      expect(error).toBeInstanceOf(ComputerBackendError);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("surfaces the toolchain's own words when the build fails", () =>
    Effect.gen(function* () {
      const { scriptPath } = yield* fakeScript(
        () => 'echo "-- Configuring" \necho "CMake Error: Could not find KWin" >&2\nexit 1',
      );
      const error = yield* Effect.flip(buildPluginFromSource({ scriptPath }));
      expect(error).toBeInstanceOf(ComputerBackendError);
      expect(error.message).toContain("Could not find KWin");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves no build process behind when interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-source-witness-" });
      const witness = yield* makeProcessWitness(scratch);
      // The script's own child, backgrounded the way a build backgrounds its
      // compilers, and the script waiting on it.
      const { scriptPath } = yield* fakeScript(
        () =>
          `${JSON.stringify(process.execPath)} -e ${JSON.stringify(witness.reportScript)} &\nwait`,
      );
      const build = yield* Effect.forkChild(buildPluginFromSource({ scriptPath }), {
        startImmediately: true,
      });
      yield* witness.reported(1);
      yield* Fiber.interrupt(build);
      expect(Exit.hasInterrupts(yield* Fiber.await(build))).toBe(true);
      // A cancel that leaves a compiler running is the failure this module
      // exists to prevent.
      yield* witness.allGone;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
