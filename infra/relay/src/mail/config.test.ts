import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { loadMailConfiguration } from "./config.ts";

describe("mail deployment configuration", () => {
  it.effect("does not require credentials while mail is disabled", () =>
    Effect.gen(function* () {
      expect(yield* loadMailConfiguration).toBeUndefined();
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
  );

  it.effect("supports BYO OAuth and polling without hosted Google or Pub/Sub credentials", () =>
    Effect.gen(function* () {
      expect(yield* loadMailConfiguration).toMatchObject({
        pubsubTopic: "",
        pubsubServiceAccount: "",
        hostedClientId: "",
      });
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            MAIL_ENABLED: "true",
            MAIL_ENCRYPTION_KEY: "test-key",
            MAIL_UPLOADTHING_API_KEY: "test-storage-key",
          }),
        ),
      ),
    ),
  );

  it.effect("still requires private storage and encryption when enabled", () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(loadMailConfiguration)).toBeDefined();
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ MAIL_ENABLED: "true" }))),
    ),
  );
});
