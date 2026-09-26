import {
  createComputerFrameSocketAtoms,
  type ComputerFrameSocketUrl,
} from "@spiritdevs/client-runtime/state/computer-frame-socket";
import { runAtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import type { ComputerId, EnvironmentId } from "@spiritdevs/contracts";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";

const computerFrameSocket = createComputerFrameSocketAtoms(connectionAtomRuntime);

/**
 * A freshly authorized frame socket URL for one computer on one environment,
 * or null while the environment cannot mint one (offline, ticket refused).
 * Remote URLs carry a short-lived ticket and report when it expires.
 */
export async function resolveComputerFrameSocketUrl(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  computerId: ComputerId,
): Promise<ComputerFrameSocketUrl | null> {
  const result = await runAtomCommand(
    registry,
    computerFrameSocket.resolveUrl,
    { environmentId, input: { computerId } },
    { reportFailure: false },
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}
