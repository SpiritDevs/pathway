import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent, OrchestrationV2ThreadShell } from "@spiritdevs/contracts";

import {
  cloudSafeThreadShell,
  shouldPublishCloudAgentThreadEvent,
} from "./cloudAgentThreadPublisher.ts";

describe("cloud Agent Thread publisher", () => {
  it("removes message text while retaining discovery metadata", () => {
    const shell = {
      id: "thread-one",
      projectId: "project-one",
      title: "Visible title",
      settleAfterCompletion: false,
      latestVisibleMessage: {
        id: "message-one",
        role: "assistant",
        text: "private transcript content",
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
    } as unknown as OrchestrationV2ThreadShell;

    expect(cloudSafeThreadShell(shell)).toMatchObject({
      id: "thread-one",
      projectId: "project-one",
      title: "Visible title",
      settleAfterCompletion: false,
      latestVisibleMessage: {
        id: "message-one",
        role: "assistant",
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
    });
    expect(cloudSafeThreadShell(shell).latestVisibleMessage).not.toHaveProperty("text");
  });

  it("waits for the final message update instead of publishing every streamed token", () => {
    const event = (streaming: boolean) =>
      ({ type: "message.updated", payload: { streaming } }) as OrchestrationV2DomainEvent;

    expect(shouldPublishCloudAgentThreadEvent(event(true))).toBe(false);
    expect(shouldPublishCloudAgentThreadEvent(event(false))).toBe(true);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "turn-item.updated",
      } as OrchestrationV2DomainEvent),
    ).toBe(false);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "thread.metadata-updated",
      } as OrchestrationV2DomainEvent),
    ).toBe(true);
  });
});
