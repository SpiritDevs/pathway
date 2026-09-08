import { makeFunctionReference, type DefaultFunctionArgs } from "convex/server";
import * as Effect from "effect/Effect";
import { RelayConvexClient } from "../db.ts";
import type { MailRpc } from "./runtime.ts";

/** Alchemy discovers the worker before key bindings exist. Acquire the client on first use. */
export const makeMailRpc = Effect.fn("mail.makeMailRpc")(function* (
  client: Effect.Effect<RelayConvexClient["Service"]>,
) {
  const getClient = yield* Effect.cached(client);
  return {
    query: <T>(name: string, args: Record<string, unknown>) =>
      Effect.runPromise(
        getClient.pipe(
          Effect.flatMap((service) =>
            service.query(
              makeFunctionReference<"query", DefaultFunctionArgs, T>(`mailRelay:${name}`),
              args as DefaultFunctionArgs,
            ),
          ),
        ),
      ),
    mutation: <T>(name: string, args: Record<string, unknown>) =>
      Effect.runPromise(
        getClient.pipe(
          Effect.flatMap((service) =>
            service.mutation(
              makeFunctionReference<"mutation", DefaultFunctionArgs, T>(`mailRelay:${name}`),
              args as DefaultFunctionArgs,
            ),
          ),
        ),
      ),
  } satisfies MailRpc;
});
