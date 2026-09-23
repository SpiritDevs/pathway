import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveComputerBinary } from "./ComputerBinaries.ts";

const environmentLayer = (options: {
  readonly isPackaged: boolean;
  readonly devServerUrl?: string;
  readonly platform?: NodeJS.Platform;
}) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/Users/alice",
    platform: options.platform ?? "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/Applications/Pathway.app/Contents/Resources/app.asar",
    isPackaged: options.isPackaged,
    resourcesPath: "/Applications/Pathway.app/Contents/Resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ VITE_DEV_SERVER_URL: options.devServerUrl }),
      ),
    ),
  );

const resolveWith = (
  binary: "pathway-helper" | "cua-driver",
  existing: ReadonlyArray<string>,
  options: Parameters<typeof environmentLayer>[0],
) =>
  resolveComputerBinary(binary).pipe(
    Effect.provide(
      Layer.merge(
        environmentLayer(options),
        FileSystem.layerNoop({ exists: (path) => Effect.succeed(existing.includes(path)) }),
      ),
    ),
  );

describe("Computer binary resolution", () => {
  it.effect("resolves both binaries from the packaged resources directory", () =>
    Effect.gen(function* () {
      const resources = "/Applications/Pathway.app/Contents/Resources";
      const existing = [
        `${resources}/pathway-helper/pathway-helper`,
        `${resources}/cua-driver/cua-driver`,
      ];
      assert.deepStrictEqual(
        yield* resolveWith("pathway-helper", existing, { isPackaged: true }),
        Option.some(`${resources}/pathway-helper/pathway-helper`),
      );
      assert.deepStrictEqual(
        yield* resolveWith("cua-driver", existing, { isPackaged: true }),
        Option.some(`${resources}/cua-driver/cua-driver`),
      );
    }),
  );

  it.effect("resolves the development build output under .electron-runtime", () =>
    Effect.gen(function* () {
      const runtime = "/repo/apps/desktop/.electron-runtime";
      assert.deepStrictEqual(
        yield* resolveWith("pathway-helper", [`${runtime}/pathway-helper/pathway-helper`], {
          isPackaged: false,
          devServerUrl: "http://127.0.0.1:5173",
        }),
        Option.some(`${runtime}/pathway-helper/pathway-helper`),
      );
      assert.deepStrictEqual(
        yield* resolveWith("cua-driver", [`${runtime}/cua-driver/cua-driver.exe`], {
          isPackaged: false,
          devServerUrl: "http://127.0.0.1:5173",
          platform: "win32",
        }),
        Option.some(`${runtime}/cua-driver/cua-driver.exe`),
      );
    }),
  );

  it.effect("reports a binary that was not built or shipped as missing", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* resolveWith("pathway-helper", [], { isPackaged: true })));
    }),
  );
});
