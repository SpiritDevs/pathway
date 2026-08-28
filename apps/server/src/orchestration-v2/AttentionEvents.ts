import {
  AttentionEventId,
  type AttentionEvent,
  type AttentionEventKind,
  type EnvironmentId,
  FocusProjectKey,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@spiritdevs/contracts";

type AttentionTransition = {
  readonly eventKind: AttentionEventKind;
  readonly transitionId: string;
};

export function attentionTransitionForEvent(
  event: OrchestrationV2DomainEvent,
): AttentionTransition | null {
  if (event.type === "run.updated") {
    switch (event.payload.status) {
      case "completed":
        return { eventKind: "finished-unsettled", transitionId: `run:${event.payload.id}` };
      case "failed":
        return { eventKind: "failed", transitionId: `run:${event.payload.id}` };
      default:
        return null;
    }
  }
  if (event.type !== "runtime-request.updated" || event.payload.status !== "pending") {
    return null;
  }
  if (event.payload.kind === "auth_refresh") {
    return null;
  }
  return {
    eventKind: event.payload.kind === "user_input" ? "awaiting-input" : "pending-approval",
    transitionId: `request:${event.payload.id}`,
  };
}

export function detectAttentionEventTransition(input: {
  readonly environmentId: EnvironmentId;
  readonly event: OrchestrationV2DomainEvent;
  readonly thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "settledAt">;
}): AttentionEvent | null {
  const transition = attentionTransitionForEvent(input.event);
  if (
    transition === null ||
    input.thread.id !== input.event.threadId ||
    input.thread.settledAt !== null
  ) {
    return null;
  }
  return {
    eventId: AttentionEventId.make(
      `attention:${input.thread.id}:${transition.transitionId}:${transition.eventKind}`,
    ),
    threadId: input.thread.id,
    projectKey: FocusProjectKey.make(`${input.environmentId}:${input.thread.projectId}`),
    eventKind: transition.eventKind,
  };
}
