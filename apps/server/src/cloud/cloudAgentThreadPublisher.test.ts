import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent, OrchestrationV2ThreadShell } from "@spiritdevs/contracts";
import { ConvexError } from "convex/values";

import {
  cloudSafeThreadShell,
  isUnpublishableAgentThreadRefusal,
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
        payload: { type: "assistant_message" },
      } as OrchestrationV2DomainEvent),
    ).toBe(false);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "turn-item.updated",
        payload: { type: "source_control", pullRequestAction: "attached" },
      } as OrchestrationV2DomainEvent),
    ).toBe(true);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "turn-item.updated",
        payload: { type: "source_control", pullRequestAction: "detached" },
      } as OrchestrationV2DomainEvent),
    ).toBe(true);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "turn-item.updated",
        payload: { type: "source_control" },
      } as OrchestrationV2DomainEvent),
    ).toBe(false);
    expect(
      shouldPublishCloudAgentThreadEvent({
        type: "thread.metadata-updated",
      } as OrchestrationV2DomainEvent),
    ).toBe(true);
  });

  it("parks only the typed binding refusal, never transport or auth failures", () => {
    expect(
      isUnpublishableAgentThreadRefusal(
        new ConvexError({
          code: "entity-not-found",
          message: "The Agent Thread project has no active binding on this environment.",
        }),
      ),
    ).toBe(true);
    expect(
      isUnpublishableAgentThreadRefusal(
        new ConvexError({ code: "permission-denied", message: "Missing permission." }),
      ),
    ).toBe(false);
    expect(isUnpublishableAgentThreadRefusal(new ConvexError("plain payload"))).toBe(false);
    expect(isUnpublishableAgentThreadRefusal(new Error("fetch failed"))).toBe(false);
    expect(isUnpublishableAgentThreadRefusal(undefined)).toBe(false);
  });
});
