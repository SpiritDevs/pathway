import { describe, expect, it } from "vite-plus/test";
import { MessageId, ProviderInstanceId, ThreadId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { buildThreadQueueSubmission } from "@spiritdevs/client-runtime/operations";
import {
  canEditQueuedChatMessage,
  canRetryQueuedChatMessage,
  queueDestinationProject,
  queueDestinationProviders,
  queuedChatMessages,
  queuedLocalChatMessage,
  queuedThreadShell,
  mergeQueuedChatTimelineMessages,
} from "./threadQueueChat";
import type { ThreadQueueDestination } from "@spiritdevs/contracts/threadQueue";

const submission = buildThreadQueueSubmission(
  {
    threadId: ThreadId.make("thread"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    message: {
      messageId: MessageId.make("message"),
      role: "user",
      text: "Keep this conversation",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: null,
        conversationCompanyId: CompanyId.make("company"),
        title: "Keep this conversation",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-09-10T00:00:00Z",
      },
    },
  },
  [{ id: "attachment", type: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 }],
);
const local = queuedLocalChatMessage({
  key: "local",
  accountId: "account",
  companyId: "company",
  threadId: "thread",
  environmentId: "offline",
  commandId: submission.input.commandId,
  submission,
  attachments: [],
  createdAt: 1000,
});
const destination: ThreadQueueDestination = {
  environmentId: "offline",
  label: "Offline machine",
  durableThreadQueue: true,
  projects: [
    {
      localProjectId: "project",
      title: "Project",
      workspaceRoot: "/workspace/project",
      cloudProjectId: "cloud-project",
    },
  ],
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      modelIds: ["gpt-5"],
      enabled: true,
      available: true,
    },
  ],
};

describe("queue records in ordinary chat", () => {
  it("keeps an earlier queued turn above a locally optimistic followup until its visible timeline receipt", () => {
    const [first] = queuedChatMessages([local], new Map());
    if (!first) throw new Error("Missing fixture");
    const followup = {
      ...first,
      id: MessageId.make("followup"),
      text: "Next turn",
      createdAt: new Date(0).toISOString(),
    };
    // Cloud persistence can timestamp the first upload after the next locally saved send.
    const merged = mergeQueuedChatTimelineMessages([followup], [first, followup], new Set());
    expect(merged.map((message) => message.id)).toEqual(["message", "followup"]);
    expect(
      mergeQueuedChatTimelineMessages([followup], [first, followup], new Set(["message"])).map(
        (message) => message.id,
      ),
    ).toEqual(["followup"]);
  });
  it("keeps the same user message and attachment identity through local and cloud delivery", () => {
    const pending = queuedChatMessages([local], new Map([["attachment", "blob:local"]]));
    const synced = queuedChatMessages(
      [{ ...local, localKey: null }],
      new Map([["attachment", "https://storage.test/notes"]]),
    );
    expect(pending[0]).toMatchObject({
      id: "message",
      role: "user",
      createdBy: "user",
      text: "Keep this conversation",
      attachments: [{ id: "attachment", previewUrl: "blob:local" }],
    });
    expect(synced[0]?.id).toBe(pending[0]?.id);
    expect(synced[0]?.attachments?.[0]?.previewUrl).toBe("https://storage.test/notes");
  });
  it("keeps accepted blocked messages recoverable without offering forbidden edits or cancellation", () => {
    expect(canEditQueuedChatMessage(local)).toBe(true);
    expect(canEditQueuedChatMessage({ ...local, submissionStarted: true })).toBe(false);
    const blocked = { ...local, localKey: null, state: "blocked" as const, acceptedAt: 5 };
    expect(canEditQueuedChatMessage(blocked)).toBe(false);
    expect(canRetryQueuedChatMessage(blocked)).toBe(true);
  });
  it("supplies the normal model picker and project context without a connected server snapshot", () => {
    expect(queueDestinationProviders(destination)[0]).toMatchObject({
      instanceId: "codex",
      enabled: true,
      models: [{ slug: "gpt-5" }],
    });
    expect(queueDestinationProject(destination, "project")).toMatchObject({
      id: "project",
      environmentId: "offline",
      workspaceRoot: "/workspace/project",
    });
  });
  it("uses a display-only ordinary thread shell for a canceled conversation", () => {
    if (submission.kind !== "launch") throw new Error("Expected launch fixture");
    const shell = queuedThreadShell(
      {
        threadId: "thread",
        environmentId: "offline",
        localProjectId: null,
        cloudProjectId: null,
        title: "Keep this conversation",
        launch: submission.input,
        state: "canceled",
        error: null,
        revision: 2,
        acceptedAt: null,
        queuedCount: 0,
        createdAt: 1000,
        updatedAt: 2000,
      },
      CompanyId.make("company"),
    );
    expect(shell).toMatchObject({
      id: "thread",
      title: "Keep this conversation",
      projectId: null,
      environmentId: "offline",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtime: null,
    });
  });
  it("opens an existing thread's queued followup on a cold client without promoting it into a new launch", () => {
    const shell = queuedThreadShell(
      {
        threadId: "thread",
        environmentId: "offline",
        localProjectId: "project",
        cloudProjectId: "cloud-project",
        title: "Existing conversation",
        launch: null,
        state: "queued",
        error: null,
        revision: 2,
        acceptedAt: 500,
        queuedCount: 1,
        createdAt: 1000,
        updatedAt: 2000,
      },
      CompanyId.make("company"),
      [],
      queueDestinationProviders(destination),
    );
    expect(shell).toMatchObject({
      id: "thread",
      title: "Existing conversation",
      projectId: "project",
      environmentId: "offline",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
    });
  });
});
