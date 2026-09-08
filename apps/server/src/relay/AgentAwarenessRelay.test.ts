import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, EventId, ProviderInstanceId, ThreadId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { emptyProjection, threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import {
  resolveAgentAwarenessRelayActiveThreadIds,
  resolveAgentAwarenessRelayPublishSnapshot,
} from "./AgentAwarenessRelay.ts";

const now = DateTime.makeUnsafe("2026-09-08T12:00:00.000Z");
const threadId = ThreadId.make("conversation-awareness");
const environmentId = EnvironmentId.make("environment-awareness");
const providerInstanceId = ProviderInstanceId.make("codex");
const thread = {
  ...threadShellFromProjection(
    emptyProjection({
      type: "thread.created",
      id: EventId.make("created-awareness"),
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: null,
        conversationCompanyId: CompanyId.make("company-one"),
        conversationPath: "/userdata/conversations/one",
        temporary: true,
        title: "Planning conversation",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        providerInstanceId,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        createdBy: "user",
        creationSource: "web",
      },
    }),
  ),
  status: "running" as const,
};

describe("conversation relay awareness", () => {
  it("includes running conversations in startup discovery and single-thread publishing", () => {
    expect(
      resolveAgentAwarenessRelayActiveThreadIds({ environmentId, projects: [], threads: [thread] }),
    ).toEqual([threadId]);
    expect(
      resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId,
        thread: Option.some(thread),
        project: Option.none(),
      }),
    ).toMatchObject({
      reason: "snapshot",
      projectId: null,
      state: {
        projectTitle: "Conversation",
        conversationCompanyId: "company-one",
        phase: "running",
        threadTitle: "Planning conversation",
      },
    });
  });
  it("does not publish a conversation without company ownership", () => {
    const missingOwner = { ...thread, conversationCompanyId: null };
    expect(
      resolveAgentAwarenessRelayActiveThreadIds({
        environmentId,
        projects: [],
        threads: [missingOwner],
      }),
    ).toEqual([]);
    expect(
      resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId,
        thread: Option.some(missingOwner),
        project: Option.none(),
      }).state,
    ).toBeNull();
  });
});
