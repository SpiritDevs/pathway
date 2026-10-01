import { APPLE_WS_METHODS } from "@spiritdevs/contracts/apple";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** App Store Connect reads served by one environment with its leased team key. */
export function createAppleEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:apple:status",
      tag: APPLE_WS_METHODS.status,
      staleTimeMs: 30_000,
    }),
    listApps: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:apple:list-apps",
      tag: APPLE_WS_METHODS.listApps,
      staleTimeMs: 30_000,
    }),
    testConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apple:test-connection",
      tag: APPLE_WS_METHODS.testConnection,
    }),
  };
}
