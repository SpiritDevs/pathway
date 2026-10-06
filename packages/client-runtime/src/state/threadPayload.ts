import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadProjectionWire,
} from "@spiritdevs/contracts";

/** Resolve compact wire references once so web and mobile keep the same in-memory projection. */
export function resolveThreadProjectionPayload(
  projection: OrchestrationV2ThreadProjectionWire,
): OrchestrationV2ThreadProjection {
  if (!("payloadFormat" in projection)) return projection;
  const { payloadFormat: _, referencedTurnItems, visibleTurnItems, ...canonical } = projection;
  const items = new Map(
    [...canonical.turnItems, ...referencedTurnItems].map((item) => [item.id, item]),
  );
  return {
    ...canonical,
    visibleTurnItems: visibleTurnItems.map((reference) => {
      const item = items.get(reference.sourceItemId);
      if (item === undefined)
        throw new Error(`Missing visible turn item ${reference.sourceItemId}`);
      return { ...reference, item };
    }),
  };
}
