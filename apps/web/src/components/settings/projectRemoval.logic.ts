import type { EnvironmentRegistrationEntity } from "@spiritdevs/client-runtime/sync";
import { isTransportConnectionErrorMessage } from "@spiritdevs/client-runtime/errors";
import type { EnvironmentId } from "@spiritdevs/contracts";

/**
 * A disconnected project may be detached directly from Convex only after its environment has
 * left the company registry. An active-but-offline environment still owns the local project and
 * will republish it when it reconnects, so treating that case as deleted would make the UI lie.
 */
export function shouldReleaseDisconnectedCloudProject(input: {
  readonly errorMessage: string | null | undefined;
  readonly environmentId: EnvironmentId;
  readonly registrations: ReadonlyArray<EnvironmentRegistrationEntity>;
}): boolean {
  return (
    isTransportConnectionErrorMessage(input.errorMessage) &&
    !input.registrations.some(
      (registration) =>
        registration.environmentId === input.environmentId && registration.state === "active",
    )
  );
}
