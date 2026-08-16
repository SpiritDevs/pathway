import { api } from "@spiritdevs/backend/convexApi";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { RelayConvexClient, RelayConvexClientError, type RelayConvexClientLike } from "./db.ts";

describe("RelayConvexClient", () => {
  it("reuses one authenticated client across operations", async () => {
    const appliedTokens: string[] = [];
    let createdClients = 0;
    let issuedTokens = 0;
    const makeClient = (): RelayConvexClientLike => {
      createdClients += 1;
      return {
        setAuth: (token) => appliedTokens.push(token),
        query: async () => [],
        mutation: async () => null,
      } as RelayConvexClientLike;
    };
    const layer = RelayConvexClient.layer({
      makeClient,
      getToken: Effect.sync(() => `token-${++issuedTokens}`),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RelayConvexClient;
        yield* client.query(api.relayPersistence.listUsersForEnvironment, {
          environmentId: "env-test",
        });
        yield* client.mutation(api.relayPersistence.unregisterDevice, {
          userId: "user-test",
          deviceId: "device-test",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(createdClients).toBe(1);
    expect(issuedTokens).toBe(1);
    expect(appliedTokens).toEqual(["token-1"]);
  });

  it("maps transport failures to a tagged client error", async () => {
    const layer = RelayConvexClient.layer({
      makeClient: () =>
        ({
          setAuth: () => undefined,
          query: async () => Promise.reject(new Error("offline")),
          mutation: async () => null,
        }) as RelayConvexClientLike,
      getToken: Effect.succeed("token"),
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* RelayConvexClient;
        yield* client.query(api.relayPersistence.listUsersForEnvironment, {
          environmentId: "env-test",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain(RelayConvexClientError.name);
  });
});
