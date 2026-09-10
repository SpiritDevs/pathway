import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
} from "@spiritdevs/contracts";
import { buildThreadQueueSubmission } from "./threadQueue.ts";
import type { StartThreadTurnInput } from "./commands.ts";
import { CompanyId } from "@spiritdevs/contracts/company";
const input: StartThreadTurnInput = {
  threadId: ThreadId.make("thread"),
  message: {
    messageId: MessageId.make("message"),
    role: "user",
    text: "Do the work",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
};
describe("cloud queue submission", () => {
  it("submits a legacy company conversation as a projectless launch", () => {
    const result = buildThreadQueueSubmission(
      {
        ...input,
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("conversations:company"),
            conversationCompanyId: CompanyId.make("company"),
            title: "Conversation",
            modelSelection: input.modelSelection!,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
            createdAt: "2026-09-10T00:00:00Z",
          },
        },
      },
      [],
    );
    expect(result).toMatchObject({
      kind: "launch",
      input: { projectId: null, conversationCompanyId: "company" },
    });
  });
  it("allocates the same command identity when recovering a send", () => {
    expect(buildThreadQueueSubmission(input, []).input.commandId).toBe(
      buildThreadQueueSubmission(input, []).input.commandId,
    );
    expect(
      buildThreadQueueSubmission({ ...input, commandId: CommandId.make("explicit") }, []).input
        .commandId,
    ).toBe("explicit");
  });
  it("queues follow-up turns and retains their selected runtime settings", () => {
    const result = buildThreadQueueSubmission(input, []);
    expect(result).toMatchObject({
      kind: "message",
      runtimeMode: "full-access",
      interactionMode: "default",
      input: { dispatchMode: { type: "queue_after_active" } },
    });
  });
  it("creates the first thread with workspace preparation in the durable payload", () => {
    const result = buildThreadQueueSubmission(
      {
        ...input,
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project"),
            title: "New thread",
            modelSelection: input.modelSelection!,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: "main",
            worktreePath: null,
            createdAt: "2026-09-10T00:00:00Z",
          },
          prepareWorktree: { projectCwd: "/project", baseBranch: "main" },
        },
      },
      [],
    );
    expect(result).toMatchObject({
      kind: "launch",
      input: {
        threadId: "thread",
        projectId: "project",
        workspaceStrategy: { type: "worktree", baseRef: "main" },
        initialMessage: { messageId: "message", text: "Do the work" },
      },
    });
  });
});

it("preserves the exact active turn targeted by explicit steering and restart", () => {
  expect(
    buildThreadQueueSubmission(
      { ...input, dispatchMode: "steer" },
      [],
      null,
      RunId.make("active-run"),
    ),
  ).toMatchObject({
    kind: "message",
    input: { dispatchMode: { type: "steer_active", targetRunId: "active-run" } },
  });
  expect(
    buildThreadQueueSubmission(
      { ...input, dispatchMode: "restart" },
      [],
      null,
      RunId.make("active-run"),
    ),
  ).toMatchObject({
    kind: "message",
    input: { dispatchMode: { type: "restart_active", targetRunId: "active-run" } },
  });
  expect(() => buildThreadQueueSubmission({ ...input, dispatchMode: "steer" }, [])).toThrow(
    "active turn is no longer available",
  );
});
