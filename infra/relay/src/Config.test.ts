import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { loadApnsCredentials, loadCyndrbaseConnect } from "./Config.ts";

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

describe("relay Cyndrbase Connect configuration", () => {
  const secure = {
    CYNDRBASE_CONNECT_API_URL: "https://connect.example.com/",
    CYNDRBASE_CONNECT_EDGE_URL: "wss://edge.example.com/connect/v1",
    CYNDRBASE_CONNECT_ADMIN_KEY: "admin-key",
  };

  it.effect("is optional", () =>
    Effect.gen(function* () {
      expect(yield* loadCyndrbaseConnect).toBeUndefined();
    }).pipe(Effect.provide(withConfig({ CYNDRBASE_CONNECT_API_URL: "" }))),
  );

  it.effect("accepts TLS URLs anywhere and plaintext only on loopback", () =>
    Effect.gen(function* () {
      const remote = yield* loadCyndrbaseConnect.pipe(Effect.provide(withConfig(secure)));
      expect(remote?.apiUrl).toBe("https://connect.example.com");
      expect(Redacted.value(remote!.adminKey)).toBe("admin-key");
      const local = yield* loadCyndrbaseConnect.pipe(
        Effect.provide(
          withConfig({
            ...secure,
            CYNDRBASE_CONNECT_API_URL: "http://127.0.0.1:8081",
            CYNDRBASE_CONNECT_EDGE_URL: "ws://localhost:8080/connect/v1",
          }),
        ),
      );
      expect(local?.edgeUrl).toBe("ws://localhost:8080/connect/v1");
    }),
  );

  it.effect("rejects plaintext URLs to remote hosts, which would carry credentials", () =>
    Effect.gen(function* () {
      for (const insecure of [
        { CYNDRBASE_CONNECT_API_URL: "http://connect.example.com" },
        { CYNDRBASE_CONNECT_EDGE_URL: "ws://edge.example.com/connect/v1" },
      ]) {
        const error = yield* Effect.flip(
          loadCyndrbaseConnect.pipe(Effect.provide(withConfig({ ...secure, ...insecure }))),
        );
        expect(error._tag).toBe("ConfigError");
      }
    }),
  );
});
