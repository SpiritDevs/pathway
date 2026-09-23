import type { ComputerAccessPolicy, EnvironmentAuthorizationError } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Who is sending, as the Computer access policy sees it (ADR 0041). The
 * orchestrator asks once for every message that requests Computer, whatever
 * path it came in on, and freezes the answer on the run.
 *
 * `clearance` is the strictest policy the sender satisfies, and fails with the
 * re-pair hint when the sender does not satisfy the current policy. Edges that
 * carry a remote principal (paired clients, the cloud queue) provide it; the
 * default is the server itself, which every policy admits.
 */
export class ComputerDispatchAccess extends Context.Reference<{
  readonly clearance: Effect.Effect<ComputerAccessPolicy, EnvironmentAuthorizationError>;
}>("@spiritdevs/pathway/orchestration-v2/ComputerDispatchAccess", {
  defaultValue: () => ({ clearance: Effect.succeed("admins-only") }),
}) {}
