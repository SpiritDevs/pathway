import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

import { bundledConnectorPath, make } from "./relayClient.ts";

describe("RelayClient", () => {
  it("runs a packaged desktop connector from beside app.asar", () => {
    const entry =
      "file:///Applications/Pathway.app/Contents/Resources/app.asar/node_modules/@cyndrbase/connect/dist/index.mjs";
    expect(bundledConnectorPath(entry, "darwin", "arm64")).toBe(
      "/Applications/Pathway.app/Contents/Resources/app.asar.unpacked/node_modules/@cyndrbase/connect/bin/darwin-arm64/cyndrbase-connector",
    );
    expect(
      bundledConnectorPath(
        "file:///srv/node_modules/@cyndrbase/connect/dist/index.mjs",
        "linux",
        "x64",
      ),
    ).toBe("/srv/node_modules/@cyndrbase/connect/bin/linux-x64/cyndrbase-connector");
  });

  it.effect("reports the bundled connector only when this platform's executable ships", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pathway-connect-" });
      yield* fileSystem.makeDirectory(`${root}/dist`);
      yield* fileSystem.makeDirectory(`${root}/bin/linux-x64`, { recursive: true });
      yield* fileSystem.writeFileString(`${root}/package.json`, '{"version":"0.1.0"}');
      const executable = `${root}/bin/linux-x64/cyndrbase-connector`;
      yield* fileSystem.writeFileString(executable, "");
      const entry = NodeURL.pathToFileURL(`${root}/dist/index.mjs`).href;
      const resolve = (arch: NodeJS.Architecture) =>
        make(entry).pipe(
          Effect.flatMap((client) => client.resolve),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcessPlatform, "linux"),
              Layer.succeed(HostProcessArchitecture, arch),
            ),
          ),
        );

      expect(yield* resolve("x64")).toEqual({
        status: "unsupported",
        platform: "linux",
        arch: "x64",
        version: "0.1.0",
      });
      yield* fileSystem.chmod(executable, 0o755);
      expect(yield* resolve("x64")).toEqual({
        status: "available",
        executablePath: executable,
        source: "managed",
        version: "0.1.0",
      });
      expect((yield* resolve("arm64")).status).toBe("unsupported");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
