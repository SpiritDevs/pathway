import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
} from "@spiritdevs/contracts";
import type * as DateTime from "effect/DateTime";

/** Resolve the request and its visible rows without creating a follow-up message. */
export function questionDismissal(
  projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "turnItems">,
  request: OrchestrationV2RuntimeRequest,
  now: DateTime.Utc,
) {
  const node = projection.nodes.find((entry) => entry.id === request.nodeId);
  const item = projection.turnItems.find(
    (entry) => entry.type === "user_input_request" && entry.requestId === request.id,
  );
  return {
    request: { ...request, status: "resolved" as const, resolvedAt: now },
    node: node ? { ...node, status: "cancelled" as const, completedAt: now } : undefined,
    item: item
      ? { ...item, status: "cancelled" as const, completedAt: now, updatedAt: now }
      : undefined,
    response:
      request.responseCapability.type === "live"
        ? {
            providerSessionId: request.responseCapability.providerSessionId,
            decision: "cancel" as const,
          }
        : undefined,
  };
}
