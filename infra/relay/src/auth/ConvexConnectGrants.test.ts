import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayConvexClient, RelayConvexClientError } from "../db.ts";
import * as ConvexConnectGrants from "./ConvexConnectGrants.ts";

const accepted = {
  status: "accepted" as const,
  environmentId: "environment-1",
  membershipId: "membership-1",
  permission: "remoteAgents.control",
  expiresAt: 1_000,
};

function clientLayer(
  mutation: (args: unknown, reference: string) => Effect.Effect<unknown, RelayConvexClientError>,
) {
  return Layer.succeed(
    RelayConvexClient,
    RelayConvexClient.of({
      query: () => Effect.die("unexpected query"),
      mutation: (reference: unknown, args: unknown) =>
        mutation(args, getFunctionName(reference as FunctionReference<"mutation">)),
    } as unknown as RelayConvexClient["Service"]),
  );
}

function testLayer(
  mutation: (args: unknown, reference: string) => Effect.Effect<unknown, RelayConvexClientError>,
) {
  return ConvexConnectGrants.layer.pipe(Layer.provide(clientLayer(mutation)));
}

describe("ConvexConnectGrants", () => {
  it.effect("hashes and validates an accepted opaque grant through Convex", () => {
    let received: unknown;
    let functionName = "";
    return Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;

      expect(
        yield* grants.validateConnectGrant({
          grant: "opaque-connect-grant",
          environmentId: "environment-1",
        }),
      ).toEqual({
        environmentId: "environment-1",
        membershipId: "membership-1",
        permission: "remoteAgents.control",
      });
      expect(functionName).toBe("connectGrants:validate");
      expect(received).toEqual({
        tokenHash: NodeCrypto.createHash("sha256").update("opaque-connect-grant").digest("hex"),
      });
    }).pipe(
      Effect.provide(
        testLayer((args, reference) =>
          Effect.sync(() => {
            received = args;
            functionName = reference;
            return accepted;
          }),
        ),
      ),
    );
  });

  it.effect("fails closed when Convex refuses the grant", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      expect(
        yield* grants.validateConnectGrant({
          grant: "refused-grant",
          environmentId: "environment-1",
        }),
      ).toBeNull();
    }).pipe(
      Effect.provide(
        testLayer(() => Effect.succeed({ status: "refused", code: "connect-grant-refused" })),
      ),
    ),
  );

  it.effect("fails closed when the accepted grant targets another environment", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      expect(
        yield* grants.validateConnectGrant({
          grant: "wrong-environment-grant",
          environmentId: "environment-2",
        }),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer(() => Effect.succeed(accepted)))),
  );

  it.effect("fails closed when Convex is unreachable", () => {
    const failure = new RelayConvexClientError({
      operation: "mutation",
      cause: new Error("offline"),
    });
    return Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      expect(
        yield* grants.validateConnectGrant({
          grant: "unreachable-grant",
          environmentId: "environment-1",
        }),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer(() => Effect.fail(failure))));
  });
});
