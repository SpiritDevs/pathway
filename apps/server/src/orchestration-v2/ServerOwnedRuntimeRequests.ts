import type { ProviderApprovalDecision, RuntimeRequestId, ThreadId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Answers runtime requests the server posted itself rather than a provider -
 * today Computer approval cards (kind `computer`, ADR 0048). The orchestrator
 * routes `runtime-request.respond` for those here instead of emitting a
 * provider effect, then resolves the card itself when the owner accepts the
 * answer.
 *
 * `respond` is false when the owner no longer has the card open. The default
 * owns nothing, so orchestration graphs without Computer (the CLI, tests)
 * refuse such answers instead of forwarding them to a provider.
 */
export class ServerOwnedRuntimeRequests extends Context.Reference<{
  readonly respond: (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly decision: ProviderApprovalDecision;
  }) => Effect.Effect<boolean>;
}>("@spiritdevs/pathway/orchestration-v2/ServerOwnedRuntimeRequests", {
  defaultValue: () => ({ respond: () => Effect.succeed(false) }),
}) {}
