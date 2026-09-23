import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { SCROLL_GEARING_FILE_NAME, ScrollGearingFile } from "./scrollGearingFile.ts";

const stateDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  return { fs, directory, filePath: path.join(directory, SCROLL_GEARING_FILE_NAME) };
});

describe("ScrollGearingFile", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("persists learned app gearing across loads", () =>
      Effect.gen(function* () {
        const { directory } = yield* stateDirectory;
        const file = yield* ScrollGearingFile.load(directory);
        expect(file.get("chromium")).toBeUndefined();

        yield* file.learn("chromium", 400, 2_800);
        yield* file.learn("chromium", 400, 3_600);
        expect(file.get("chromium")).toBe(8);

        const reloaded = yield* ScrollGearingFile.load(directory);
        expect(reloaded.get("chromium")).toBe(8);
      }),
    );

    it.effect("applies the hot store's admissibility rules", () =>
      Effect.gen(function* () {
        const { directory, fs, filePath } = yield* stateDirectory;
        const file = yield* ScrollGearingFile.load(directory);
        yield* file.learn("app", 400, 0);
        yield* file.learn("app", 400, -2_800);
        yield* file.learn("app", 20, 140);
        yield* file.learn("app", 400, 400_000);
        yield* file.learn(undefined, 400, 2_800);
        expect(file.get("app")).toBeUndefined();
        // Nothing accepted, nothing written.
        expect(yield* fs.exists(filePath)).toBe(false);
      }),
    );

    it.effect("reads a corrupt, foreign, or out-of-range file as unmeasured", () =>
      Effect.gen(function* () {
        const { directory, fs, filePath } = yield* stateDirectory;
        yield* fs.writeFileString(filePath, "{not json");
        expect((yield* ScrollGearingFile.load(directory)).get("app")).toBeUndefined();

        yield* fs.writeFileString(
          filePath,
          '{"version":2,"apps":{"app":{"gearing":3,"samples":1,"updatedAt":1}}}',
        );
        expect((yield* ScrollGearingFile.load(directory)).get("app")).toBeUndefined();

        yield* fs.writeFileString(
          filePath,
          `{"version":1,"apps":{
            "good":{"gearing":3,"samples":2,"updatedAt":1},
            "tooGeared":{"gearing":51,"samples":1,"updatedAt":1},
            "noSamples":{"gearing":3,"samples":0,"updatedAt":1},
            "fractionalSamples":{"gearing":3,"samples":1.5,"updatedAt":1},
            "notAnEntry":"3"
          }}`,
        );
        const file = yield* ScrollGearingFile.load(directory);
        expect(file.get("good")).toBe(3);
        expect(file.get("tooGeared")).toBeUndefined();
        expect(file.get("noSamples")).toBeUndefined();
        expect(file.get("fractionalSamples")).toBeUndefined();
        expect(file.get("notAnEntry")).toBeUndefined();
      }),
    );

    it.effect("forgets the least recently updated app past the bound", () =>
      Effect.gen(function* () {
        const { directory } = yield* stateDirectory;
        const file = yield* ScrollGearingFile.load(directory);
        for (let index = 0; index < 64; index += 1) {
          yield* file.learn(`app${index}`, 400, 2_800);
          yield* TestClock.adjust("1 millis");
        }
        // Refreshing the oldest app makes app1 the stalest.
        yield* file.learn("app0", 400, 2_800);
        yield* TestClock.adjust("1 millis");
        yield* file.learn("app64", 400, 2_800);
        expect(file.get("app0")).toBe(7);
        expect(file.get("app1")).toBeUndefined();
        expect(file.get("app64")).toBe(7);

        const reloaded = yield* ScrollGearingFile.load(directory);
        expect(reloaded.get("app1")).toBeUndefined();
        expect(reloaded.get("app64")).toBe(7);
      }),
    );
  });

  it.effect("keeps gearing in memory when no state directory is given", () =>
    Effect.gen(function* () {
      const file = yield* ScrollGearingFile.load(undefined).pipe(
        Effect.provide(NodeServices.layer),
      );
      yield* file.learn("app", 400, 2_800);
      expect(file.get("app")).toBe(7);
    }),
  );
});
