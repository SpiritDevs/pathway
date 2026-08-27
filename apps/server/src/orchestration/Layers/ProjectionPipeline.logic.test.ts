import type { OrchestrationEvent } from "@spiritdevs/contracts/legacy-orchestration";
import { describe, expect, it } from "vite-plus/test";

import { shouldRefreshThreadShellSummary } from "./ProjectionPipeline.ts";

function event(type: OrchestrationEvent["type"], payload: unknown): OrchestrationEvent {
  return { type, payload } as OrchestrationEvent;
}

describe("shouldRefreshThreadShellSummary", () => {
  it("skips assistant messages and routine activity", () => {
    expect(
      shouldRefreshThreadShellSummary(event("thread.message-sent", { role: "assistant" })),
    ).toBe(false);
    expect(
      shouldRefreshThreadShellSummary(
        event("thread.activity-appended", { activity: { kind: "tool.updated" } }),
      ),
    ).toBe(false);
  });

  it("refreshes user messages and blocked-on-user activity", () => {
    expect(shouldRefreshThreadShellSummary(event("thread.message-sent", { role: "user" }))).toBe(
      true,
    );
    expect(
      shouldRefreshThreadShellSummary(
        event("thread.activity-appended", { activity: { kind: "approval.requested" } }),
      ),
    ).toBe(true);
  });

  it("refreshes other shell-summary events", () => {
    expect(shouldRefreshThreadShellSummary(event("thread.proposed-plan-upserted", {}))).toBe(true);
  });
});
