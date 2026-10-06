import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@spiritdevs/contracts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { resolveThreadProjectionPayload } from "./threadPayload.ts";

const item = (id: string, threadId = v2ThreadId): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  type: "command_execution",
  status: "completed",
  title: null,
  input: "example",
  output: "preview",
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
});

describe("thread payload references", () => {
  it("resolves local, inherited, and synthetic items without copying their bodies or importing inherited history", () => {
    const local = item("local");
    const inherited = item("inherited", ThreadId.make("source"));
    const synthetic = item("synthetic");
    const references = [local, inherited, synthetic].map((item, position) => ({
      position: position + 50,
      visibility: (["local", "inherited", "synthetic"] as const)[position]!,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
    }));
    const resolved = resolveThreadProjectionPayload({
      ...v2Projection,
      payloadFormat: "compact-v1",
      turnItems: [local],
      referencedTurnItems: [inherited, synthetic],
      visibleTurnItems: references,
    });
    expect(resolved.visibleTurnItems.map((row) => row.item)).toEqual([local, inherited, synthetic]);
    expect(resolved.visibleTurnItems[0]!.item).toBe(resolved.turnItems[0]);
    expect(resolved.visibleTurnItems[1]!.item).toBe(inherited);
    expect(resolved.visibleTurnItems.map((row) => row.position)).toEqual([50, 51, 52]);
    expect(resolved.turnItems).toEqual([local]);
    expect(resolved).not.toHaveProperty("referencedTurnItems");
    expect(resolved).not.toHaveProperty("payloadFormat");
  });

  it("preserves legacy server projections", () => {
    expect(resolveThreadProjectionPayload(v2Projection)).toBe(v2Projection);
  });

  it("rejects a broken reference instead of silently dropping a visible row", () => {
    expect(() =>
      resolveThreadProjectionPayload({
        ...v2Projection,
        payloadFormat: "references-v1",
        referencedTurnItems: [],
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: v2ThreadId,
            sourceItemId: TurnItemId.make("missing"),
          },
        ],
      }),
    ).toThrow("Missing visible turn item");
  });
});
