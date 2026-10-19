import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readPrebuiltManifest } from "../kwinPluginProvisioning.ts";

describe.each([
  {
    backend: "KWin",
    readManifest: readPrebuiltManifest,
    version: { kwinVersion: "6.7.3", builtOn: "fedora-43" },
  },
])("$backend prebuilt manifest validation", ({ readManifest, version }) => {
  it.live("drops malformed and escaping entries while retaining usable builds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "pathway-prebuilt-validation-",
      });
      const path = paths.join(directory, "manifest.json");
      const valid = { ...version, arch: "x64", file: "plugin.so", sha256: "a".repeat(64) };
      const invalid = [
        null,
        false,
        [],
        {},
        { ...valid, arch: "" },
        { ...valid, arch: 42 },
        { ...valid, sha256: "" },
        { ...valid, sha256: "00" },
        { ...valid, sha256: "z".repeat(64) },
        { ...valid, sha256: 42 },
        ...[
          "../outside.so",
          "/outside.so",
          "dir/plugin.so",
          "dir\\plugin.so",
          ".",
          "..",
          "",
          "\0.so",
        ].map((file) => Object.assign({}, valid, { file })),
      ];

      // @effect-diagnostics-next-line preferSchemaOverJson:off - the fixture is the JSON the release workflow writes.
      yield* fs.writeFileString(path, JSON.stringify({ builds: [...invalid, valid] }));
      expect(yield* readManifest(path)).toEqual({ builds: [valid] });

      // @effect-diagnostics-next-line preferSchemaOverJson:off - the fixture is the JSON the release workflow writes.
      yield* fs.writeFileString(path, JSON.stringify({ builds: invalid }));
      expect(yield* readManifest(path)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
