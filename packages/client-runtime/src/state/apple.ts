import { APPLE_WS_METHODS } from "@spiritdevs/contracts/apple";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
    /** The environment's Apple ID download session for one account; closes with the last watcher. */
    idSession: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:apple:id-session",
      tag: APPLE_WS_METHODS.appleIdSubscribe,
      idleTtlMs: 0,
    }),
    idStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apple:id-start",
      tag: APPLE_WS_METHODS.appleIdStart,
    }),
    idComplete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apple:id-complete",
      tag: APPLE_WS_METHODS.appleIdComplete,
    }),
    idRequestCode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apple:id-request-code",
      tag: APPLE_WS_METHODS.appleIdRequestCode,
    }),
    idCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apple:id-cancel",
      tag: APPLE_WS_METHODS.appleIdCancel,
    }),
    idSignOut: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apple:id-sign-out",
      tag: APPLE_WS_METHODS.appleIdSignOut,
    }),
  };
}
