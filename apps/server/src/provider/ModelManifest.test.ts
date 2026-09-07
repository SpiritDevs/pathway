import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
class Offline extends Schema.TaggedErrorClass<Offline>()("Offline", {}) {}
import { BUNDLED_MODEL_MANIFEST, classifyModels, makeModelManifest } from "./ModelManifest.ts";

it("classifies discovered Astra and unknown models without inventing availability or capabilities", () => {
  const models = [
    { slug: "gpt-6-astra", name: "Astra", isCustom: false, isLegacy: true, capabilities: null },
    { slug: "future-model", name: "Future", isCustom: false, isLegacy: true, capabilities: null },
    { slug: "gpt-5.4", name: "Old", isCustom: false, capabilities: null },
  ];
  const result = classifyModels(models, BUNDLED_MODEL_MANIFEST, "codex");
  assert.lengthOf(result, 3);
  assert.isUndefined(result[0]?.isLegacy);
  assert.isUndefined(result[1]?.isLegacy);
  assert.isTrue(result[2]?.isLegacy);
  assert.isNull(result[0]?.capabilities);
});

it.layer(NodeServices.layer)("model manifest cache", (it) => {
  it.effect("retains the last good manifest after a failed refresh and recovers after retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-manifest-" });
      let count = 0;
      const newer = { ...BUNDLED_MODEL_MANIFEST, updatedAt: "2026-09-08T00:00:00Z" };
      const service = yield* makeModelManifest({
        cachePath: `${dir}/manifest.json`,
        enabled: Effect.succeed(true),
        fetch: Effect.suspend(() =>
          ++count === 1 ? Effect.fail(new Offline()) : Effect.succeed(newer),
        ),
      });
      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MODEL_MANIFEST);
      yield* service.refresh;
      assert.strictEqual(count, 1);
      yield* TestClock.adjust(300_001);
      assert.deepStrictEqual(yield* service.refresh, newer);
      const restarted = yield* makeModelManifest({
        cachePath: `${dir}/manifest.json`,
        enabled: Effect.succeed(false),
        fetch: Effect.die("must not fetch"),
      });
      assert.deepStrictEqual(yield* restarted.current, newer);
      assert.deepStrictEqual(yield* restarted.refresh, newer);
    }),
  );

  it.effect("rejects invalid and older remote metadata without replacing the bundle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-manifest-" });
      for (const data of [{ version: 2 }, { ...BUNDLED_MODEL_MANIFEST, updatedAt: "2020-01-01" }]) {
        const service = yield* makeModelManifest({
          cachePath: `${dir}/manifest.json`,
          enabled: Effect.succeed(true),
          fetch: Effect.succeed(data),
        });
        assert.deepStrictEqual(yield* service.refresh, BUNDLED_MODEL_MANIFEST);
      }
    }),
  );
});
