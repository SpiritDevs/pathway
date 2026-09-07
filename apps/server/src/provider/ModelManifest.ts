import type { ServerProviderModel } from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import bundled from "./model-manifest.json" with { type: "json" };

export const MODEL_MANIFEST_URL =
  "https://raw.githubusercontent.com/SpiritDevs/pathway/main/apps/server/src/provider/model-manifest.json";

export const ModelManifestData = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
  models: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Literals(["current", "legacy"])),
  ),
});
export type ModelManifestData = typeof ModelManifestData.Type;
export const BUNDLED_MODEL_MANIFEST = Schema.decodeUnknownSync(ModelManifestData)(bundled);
const Cache = Schema.fromJsonString(
  Schema.Struct({
    fetchedAt: Schema.Number,
    manifest: ModelManifestData,
  }),
);

export function classifyModels(
  models: ReadonlyArray<ServerProviderModel>,
  manifest: ModelManifestData,
  driver: string,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (model.isCustom) return model;
    const status = manifest.models[driver]?.[model.slug];
    if (status === "legacy") return model.isLegacy ? model : { ...model, isLegacy: true };
    if (!model.isLegacy) return model;
    const { isLegacy: _legacy, ...current } = model;
    return current;
  });
}

interface ModelManifestService {
  readonly current: Effect.Effect<ModelManifestData>;
  readonly refresh: Effect.Effect<ModelManifestData>;
}

/** Tests and standalone drivers use the bundle; production provides the shared cache. */
export const ModelManifest = Context.Reference<ModelManifestService>(
  "@spiritdevs/pathway/provider/ModelManifest",
  {
    defaultValue: () => ({
      current: Effect.succeed(BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
    }),
  },
);

export const makeModelManifest = Effect.fn("ModelManifest.make")(function* (options: {
  readonly cachePath: string;
  readonly enabled: Effect.Effect<boolean>;
  readonly fetch: Effect.Effect<unknown, Error>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const gate = yield* Semaphore.make(1);
  let manifest = BUNDLED_MODEL_MANIFEST;
  let fetchedAt: number | null = null;
  let attemptedAt: number | null = null;
  const load = yield* Effect.cached(
    fs.readFileString(options.cachePath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Cache)),
      Effect.tap((cache) =>
        Effect.sync(() => {
          if (Date.parse(cache.manifest.updatedAt) >= Date.parse(manifest.updatedAt)) {
            manifest = cache.manifest;
            fetchedAt = cache.fetchedAt;
          }
        }),
      ),
      Effect.catch(() => Effect.void),
    ),
  );
  const current = load.pipe(Effect.map(() => manifest));
  const refresh = gate.withPermits(1)(
    Effect.gen(function* () {
      yield* load;
      if (!(yield* options.enabled)) return manifest;
      const now = yield* Clock.currentTimeMillis;
      const fresh = (at: number | null, ttl: number) => at !== null && now >= at && now - at < ttl;
      if (fresh(fetchedAt, 3_600_000) || fresh(attemptedAt, 300_000)) return manifest;
      attemptedAt = now;
      const candidate = yield* options.fetch.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ModelManifestData)),
        Effect.timeout(10_000),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (!candidate || Date.parse(candidate.updatedAt) < Date.parse(manifest.updatedAt))
        return manifest;
      manifest = candidate;
      fetchedAt = now;
      yield* Schema.encodeEffect(Cache)({ fetchedAt: now, manifest }).pipe(
        Effect.flatMap((serialized) => fs.writeFileString(`${options.cachePath}.tmp`, serialized)),
        Effect.andThen(fs.rename(`${options.cachePath}.tmp`, options.cachePath)),
        Effect.catch(() => Effect.void),
      );
      return manifest;
    }),
  );
  return { current, refresh } satisfies ModelManifestService;
});

export const layer = Layer.effect(
  ModelManifest,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const settings = yield* ServerSettingsService;
    const http = yield* HttpClient.HttpClient;
    return yield* makeModelManifest({
      cachePath: path.join(config.stateDir, "model-manifest.json"),
      enabled: settings.getSettings.pipe(
        Effect.map((value) => value.enableProviderUpdateChecks),
        Effect.catch(() => Effect.succeed(false)),
      ),
      fetch: http.get(MODEL_MANIFEST_URL).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
      ),
    });
  }),
);
