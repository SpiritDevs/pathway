import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@spiritdevs/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
} from "@spiritdevs/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
const environmentShellBootstrappedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(environmentSnapshotAtom(environmentId)) !== null).pipe(
    Atom.withLabel(`environment-shell-bootstrapped:${environmentId}`),
  ),
);
const NO_ENVIRONMENT_SHELL_ATOM = Atom.make(false);

/** Whether the environment's shell has loaded, without re-rendering on every thread update. */
export function useEnvironmentShellBootstrapped(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? NO_ENVIRONMENT_SHELL_ATOM
      : environmentShellBootstrappedAtom(environmentId),
  );
}

export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

// A snapshot-less environment holds the landing open only while it is within
// its first two attempts; once it has burned those, later retries must not
// keep flipping the gate between settled and loading.
export function environmentHoldsLanding(connection: SupervisorConnectionState): boolean {
  if (!connection.desired || connection.attempt > 2) {
    return false;
  }
  if (connectionProjectionPhase(connection) !== "disconnected") {
    return true;
  }
  // A retrying environment is only transiently disconnected; wait out its
  // early backoff before settling without its snapshot.
  return connection.phase === "backoff";
}

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of catalog.value.entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (environmentHoldsLanding(connection)) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));
