import { describe, expect, it } from "@effect/vitest";
import { getFunctionName } from "convex/server";
import * as Effect from "effect/Effect";
import { RelayConvexClient, type RelayConvexClientLike } from "../db.ts";
import { makeMailRpc } from "./rpc.ts";

describe("mail RPC initialization", () => {
  it.effect("can discover the worker before runtime signing keys are bound", () =>
    Effect.gen(function* () {
      const rpc = yield* makeMailRpc(Effect.die("Signing keys are not bound during discovery"));
      expect(rpc.query).toBeTypeOf("function");
      expect(rpc.mutation).toBeTypeOf("function");
    }),
  );

  it.effect("authenticates on first use and shares the client across mail operations", () =>
    Effect.gen(function* () {
      let createdClients = 0;
      let signedTokens = 0;
      const tokens: string[] = [];
      const calls: unknown[] = [];
      const rpc = yield* makeMailRpc(
        RelayConvexClient.pipe(
          Effect.provide(
            RelayConvexClient.layer({
              getToken: Effect.sync(() => `token-${++signedTokens}`),
              makeClient: () => {
                createdClients++;
                return {
                  setAuth: (token) => tokens.push(token),
                  query: async (reference, args) => {
                    calls.push([getFunctionName(reference), args]);
                    return ["account"];
                  },
                  mutation: async (reference, args) => {
                    calls.push([getFunctionName(reference), args]);
                    return { accepted: true };
                  },
                } as RelayConvexClientLike;
              },
            }),
          ),
        ),
      );
      expect(createdClients).toBe(0);
      expect(signedTokens).toBe(0);
      expect(yield* Effect.promise(() => rpc.query("accounts", { owner: "owner" }))).toEqual([
        "account",
      ]);
      expect(yield* Effect.promise(() => rpc.mutation("wake", { accountId: "account" }))).toEqual({
        accepted: true,
      });
      expect(createdClients).toBe(1);
      expect(signedTokens).toBe(1);
      expect(tokens).toEqual(["token-1"]);
      expect(calls).toEqual([
        ["mailRelay:accounts", { owner: "owner" }],
        ["mailRelay:wake", { accountId: "account" }],
      ]);
    }),
  );
});
