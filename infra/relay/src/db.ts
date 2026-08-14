import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class RelayConvexClientError extends Schema.TaggedErrorClass<RelayConvexClientError>()(
  "RelayConvexClientError",
  {
    operation: Schema.Literals(["query", "mutation", "authenticate"]),
    cause: Schema.Defect(),
  },
) {}

export interface RelayConvexClientLike {
  readonly setAuth: (token: string) => void;
  readonly query: <Query extends FunctionReference<"query">>(
    query: Query,
    ...args: FunctionArgs<Query> extends Record<string, never>
      ? [args?: FunctionArgs<Query>]
      : [args: FunctionArgs<Query>]
  ) => Promise<FunctionReturnType<Query>>;
  readonly mutation: <Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    ...args: FunctionArgs<Mutation> extends Record<string, never>
      ? [args?: FunctionArgs<Mutation>]
      : [args: FunctionArgs<Mutation>]
  ) => Promise<FunctionReturnType<Mutation>>;
}

/**
 * Effect boundary around the authenticated Convex client owned by the relay
 * Worker. Repository services depend on this instead of knowing how the
 * control-plane token is minted or refreshed.
 */
export class RelayConvexClient extends Context.Service<
  RelayConvexClient,
  {
    readonly query: <Query extends FunctionReference<"query">>(
      query: Query,
      args: FunctionArgs<Query>,
    ) => Effect.Effect<FunctionReturnType<Query>, RelayConvexClientError>;
    readonly mutation: <Mutation extends FunctionReference<"mutation">>(
      mutation: Mutation,
      args: FunctionArgs<Mutation>,
    ) => Effect.Effect<FunctionReturnType<Mutation>, RelayConvexClientError>;
  }
>()("pathway-relay/db/RelayConvexClient") {
  /** A fresh client keeps token assignment local to one request under concurrency. */
  static readonly layer = <TokenError>(input: {
    readonly makeClient: () => RelayConvexClientLike;
    readonly getToken: Effect.Effect<string, TokenError>;
  }) =>
    Layer.succeed(
      RelayConvexClient,
      RelayConvexClient.of({
        query: (query, args) =>
          Effect.gen(function* () {
            const client = input.makeClient();
            client.setAuth(
              yield* input.getToken.pipe(
                Effect.mapError(
                  (cause) => new RelayConvexClientError({ operation: "authenticate", cause }),
                ),
              ),
            );
            return yield* Effect.tryPromise({
              try: () => client.query(query, args),
              catch: (cause) => new RelayConvexClientError({ operation: "query", cause }),
            });
          }),
        mutation: (mutation, args) =>
          Effect.gen(function* () {
            const client = input.makeClient();
            client.setAuth(
              yield* input.getToken.pipe(
                Effect.mapError(
                  (cause) => new RelayConvexClientError({ operation: "authenticate", cause }),
                ),
              ),
            );
            return yield* Effect.tryPromise({
              try: () => client.mutation(mutation, args),
              catch: (cause) => new RelayConvexClientError({ operation: "mutation", cause }),
            });
          }),
      }),
    );
}
