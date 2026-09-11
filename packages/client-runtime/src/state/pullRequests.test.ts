import type {
  SupervisorConnectionState,
  PreparedConnection,
  NetworkStatus,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { RpcSession } from "../rpc/session.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type PullRequestDetail,
} from "@spiritdevs/contracts";
import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createPullRequestEnvironmentAtoms, PullRequestDiffLoader } from "./pullRequests.ts";

it.effect(
  "coalesces explicit refreshes, invalidates before reading, and updates passive observers",
  () =>
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("remote-test"),
        label: "Remote",
        httpBaseUrl: "https://test.invalid",
        wsBaseUrl: "wss://test.invalid",
      });
      const input = {
        projectId: ProjectId.make("project"),
        repository: "example/repo",
        number: 149,
      };
      const events: string[] = [];
      let mergeability = "conflicting";
      let invalidateFails = false;
      const client = {
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.sync(() => {
            events.push(`detail:${mergeability}`);
            return {
              ...input,
              mergeability,
              state: "open",
              url: "https://github.com/example/repo/pull/149",
            } as PullRequestDetail;
          }),
        [WS_METHODS.pullRequestsInvalidate]: () =>
          Effect.suspend(() => {
            events.push("invalidate");
            return invalidateFails
              ? Effect.fail(
                  new EnvironmentRpcUnavailableError({
                    environmentId: target.environmentId,
                    message: "offline",
                  }),
                )
              : Effect.void;
          }),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
          Option.some({
            client,
            initialConfig: Effect.never,
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          }),
        ),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.mock(EnvironmentRegistry)({
            entries: yield* SubscriptionRef.make<
              ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
            >(new Map()),
            networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
            run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
            followStream: (_id, stream) =>
              Stream.provideService(stream, EnvironmentSupervisor, supervisor),
          }),
          Layer.mock(PullRequestDiffLoader)({}),
        ),
      );
      const atoms = createPullRequestEnvironmentAtoms(runtime);
      const registry = AtomRegistry.make();
      try {
        const queryTarget = { environmentId: target.environmentId, input };
        const detail = atoms.detail(queryTarget);
        registry.mount(detail);
        expect((yield* AtomRegistry.getResult(registry, detail)).mergeability).toBe("conflicting");
        mergeability = "mergeable";
        const results = yield* Effect.promise(() =>
          Promise.all([
            atoms.refreshDetail.run(registry, queryTarget),
            atoms.refreshDetail.run(registry, queryTarget),
          ]),
        );
        expect(results.map((result) => result._tag)).toEqual(["Success", "Success"]);
        expect(events).toEqual(["detail:conflicting", "invalidate", "detail:mergeable"]);
        expect((yield* AtomRegistry.getResult(registry, detail)).mergeability).toBe("mergeable");
        invalidateFails = true;
        const failure = yield* Effect.promise(() => atoms.refreshDetail.run(registry, queryTarget));
        expect(failure._tag).toBe("Failure");
        expect(events.at(-1)).toBe("invalidate");
      } finally {
        registry.dispose();
      }
    }),
);
