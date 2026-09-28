import type { EnvironmentSurfaceTarget, EnvironmentSurfaceViewport } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { createEnvironmentCommand } from "../state/runtime.ts";
import { resolveSurfaceSocketUrl } from "./socketUrl.ts";

/**
 * `resolveUrl` mints a surface socket URL against the environment's current
 * prepared connection. Pass it as the stream's `resolveUrl` so every reconnect
 * picks up fresh credentials and relay routes.
 */
export function createSurfaceSocketAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    resolveUrl: createEnvironmentCommand(runtime, {
      label: "environment-data:surface:socket-url",
      execute: (
        input: {
          readonly target: EnvironmentSurfaceTarget;
          readonly viewport: EnvironmentSurfaceViewport;
        },
        _registry,
        environmentId,
      ) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return yield* new EnvironmentRpcUnavailableError({
              environmentId,
              message: "The environment is not connected.",
            });
          }
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          return yield* resolveSurfaceSocketUrl({
            prepared: prepared.value,
            target: input.target,
            viewport: input.viewport,
            signer,
          });
        }),
    }),
  };
}
