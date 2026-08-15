import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { loadApnsCredentials } from "./Config.ts";

const withConfig = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values));

describe("relay APNs configuration", () => {
  it.effect("does not read Apple credentials when APNs is disabled", () =>
    Effect.gen(function* () {
      expect(yield* loadApnsCredentials).toBeUndefined();
    }).pipe(Effect.provide(withConfig({ APNS_ENABLED: "false" }))),
  );

  it.effect("loads Apple credentials when APNs is enabled", () =>
    Effect.gen(function* () {
      const credentials = yield* loadApnsCredentials;
      expect(credentials).toMatchObject({
        environment: "production",
        teamId: "team-id",
        keyId: "key-id",
        bundleId: "com.spiritdevs.pathway",
      });
      expect(Redacted.value(credentials!.privateKey)).toBe("private-key");
    }).pipe(
      Effect.provide(
        withConfig({
          APNS_ENABLED: "true",
          APNS_ENVIRONMENT: "production",
          APNS_TEAM_ID: "team-id",
          APNS_KEY_ID: "key-id",
          APNS_BUNDLE_ID: "com.spiritdevs.pathway",
          APNS_PRIVATE_KEY: "private-key",
        }),
      ),
    ),
  );

  it.effect("keeps APNs enabled by default for existing deployments", () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(loadApnsCredentials)).toBeDefined();
    }).pipe(Effect.provide(withConfig({}))),
  );
});
