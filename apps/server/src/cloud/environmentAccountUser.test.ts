import { assert, it } from "@effect/vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";

import type { ConvexClientLike } from "./convexSyncTransport.ts";
import { queryEnvironmentAccountUser } from "./environmentAccountUser.ts";

it.effect(
  "queries the internal account id using the environment token and retries an expired token",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client: ConvexClientLike = {
        setAuth: (token) => {
          calls.push(token);
        },
        query: ((reference: FunctionReference<"query">, args: unknown) => {
          assert.equal(getFunctionName(reference), "connectGrants:accountUser");
          assert.deepStrictEqual(args, {});
          return calls.length === 1
            ? Promise.reject(new ConvexError({ code: "not-authenticated" }))
            : Promise.resolve("internal-cloud-user");
        }) as ConvexClientLike["query"],
        mutation: () => Promise.reject(new Error("unexpected mutation")),
      };
      const userId = yield* queryEnvironmentAccountUser({
        client,
        tokens: {
          token: Effect.sync(() =>
            calls.length === 0 ? "expired-environment-token" : "fresh-environment-token",
          ),
          invalidate: (token) =>
            Effect.sync(() => {
              assert.equal(token, "expired-environment-token");
            }),
        },
      });
      assert.equal(userId, "internal-cloud-user");
      assert.deepStrictEqual(calls, ["expired-environment-token", "fresh-environment-token"]);
    }),
);

it.effect("fails account resolution when Cloud refuses the linked environment", () =>
  Effect.gen(function* () {
    const failure = yield* queryEnvironmentAccountUser({
      client: {
        setAuth: () => {},
        query: () =>
          Promise.reject(new ConvexError({ code: "permission-denied", message: "unlinked" })),
        mutation: () => Promise.reject(new Error("unexpected mutation")),
      },
      tokens: { token: Effect.succeed("environment-token"), invalidate: () => Effect.void },
    }).pipe(Effect.flip);
    assert.equal(failure.reason, "unauthorized");
  }),
);
