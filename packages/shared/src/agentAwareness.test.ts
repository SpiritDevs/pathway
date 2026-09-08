import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ThreadId,
} from "@spiritdevs/contracts";
import { ProviderInstanceId, RuntimeRequestId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as DateTime from "effect/DateTime";

import { projectThreadAwarenessV2 } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "pathway",
} satisfies Pick<Project, "title">;

describe("projectThreadAwarenessV2", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const v2Thread = (
    overrides: Partial<
      Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status" | "pendingRuntimeRequest">
    > = {},
  ) => ({
    id: "thread-2" as ThreadId,
    title: "Integrate orchestration",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "running" as const,
    pendingRuntimeRequest: null,
    updatedAt,
    ...overrides,
  });

  it("projects V2 run state", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread(),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it("represents conversation activity with its owning company and normal phase ladder", () => {
    const owner = CompanyId.make("company-conversation");
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project: null,
      conversationCompanyId: owner,
      thread: v2Thread(),
    };
    expect(projectThreadAwarenessV2(input)).toMatchObject({
      phase: "running",
      projectTitle: "Conversation",
      conversationCompanyId: owner,
      threadId: "thread-2",
      deepLink: "/threads/env-1/thread-2",
    });
    expect(projectThreadAwarenessV2({ ...input, conversationCompanyId: null })).toBeNull();
    expect(
      projectThreadAwarenessV2({ ...input, thread: v2Thread({ status: "completed" }) }),
    ).toMatchObject({ phase: "completed" });
    expect(projectThreadAwarenessV2({ ...input, project })).not.toHaveProperty(
      "conversationCompanyId",
    );
  });

  it("keeps an older activity run visible over a newer cancelled run", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "cancelled", activityRunStatus: "running" }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it("prioritizes V2 user-input requests", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "waiting_for_input", headline: "Waiting for input" });
  });

  it("does not present authentication refreshes as user approvals", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth-refresh"),
            kind: "auth_refresh",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });
});
