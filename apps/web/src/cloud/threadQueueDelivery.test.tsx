import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom, AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { buildThreadQueueSubmission } from "@spiritdevs/client-runtime/operations";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  uploadStandaloneFileAttachment,
  verifyReadyAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import {
  localThreadQueueAtom,
  threadQueueHydratedAtom,
  threadQueueRowsAtom,
} from "./threadQueueState";
import { useQueuedStartThreadTurn, type QueuedThreadTurnTarget } from "./threadQueue";

const { startTurn, readProjection, auth } = vi.hoisted(() => ({
  startTurn: vi.fn(async (_target: QueuedThreadTurnTarget) => ({
    _tag: "Success" as const,
    value: { sequence: 1 },
  })),
  readProjection: vi.fn(() => null),
  auth: { userId: "account" as string | null },
}));

vi.mock("@clerk/react", () => ({ useAuth: () => auth }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: AtomRegistry.make() }));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  readThreadProjection: readProjection,
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => startTurn }));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => connection },
}));
vi.mock("../lib/attachmentUploadQueue", () => ({
  verifyReadyAttachmentUpload: vi.fn(),
  uploadStandaloneFileAttachment: vi.fn(),
}));
vi.mock("./activeCompany", () => ({
  scopedCompanyRegistryReplicasAtom: Atom.make([]),
  activeCompanyIdAtom: Atom.make(null),
  companyListAtom: Atom.make([]),
}));
vi.mock("./companyRegistryReplica", () => ({ companyRegistryReplicasAtom: Atom.make([]) }));

const connection = Atom.make(AsyncResult.success({ phase: "connected" }));
const target: QueuedThreadTurnTarget = {
  environmentId: EnvironmentId.make("environment"),
  input: {
    threadId: ThreadId.make("new-thread"),
    message: {
      messageId: MessageId.make("first-message"),
      role: "user",
      text: "Start working",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: ProjectId.make("project"),
        title: "Start working",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: "2026-09-12T00:00:00.000Z",
      },
    },
  },
};

const pending = {
  key: "pending",
  accountId: "account",
  companyId: "company",
  environmentId: target.environmentId,
  threadId: target.input.threadId,
  commandId: "pending-command",
  createdAt: 1,
  attachments: [],
  submission: buildThreadQueueSubmission(target.input, []),
};

function renderSend() {
  let send: ReturnType<typeof useQueuedStartThreadTurn> | undefined;
  function Composer() {
    send = useQueuedStartThreadTurn();
    return null;
  }
  renderToStaticMarkup(<Composer />);
  return send!;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.userId = "account";
  appAtomRegistry.set(connection, AsyncResult.success({ phase: "connected" }));
  appAtomRegistry.set(threadQueueHydratedAtom, false);
  appAtomRegistry.set(threadQueueRowsAtom, []);
  appAtomRegistry.set(localThreadQueueAtom, []);
});

describe("connected thread delivery without cloud queue readiness", () => {
  it("still requires a signed-in Pathway account", async () => {
    auth.userId = null;
    expect(await renderSend()(target)).toMatchObject({ _tag: "Failure" });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it.each(["root", "worktree", "existing_worktree", "conversation"])(
    "sends a new %s launch directly before any thread projection exists",
    async (workspace) => {
      const createThread = target.input.bootstrap!.createThread!;
      const launch = {
        ...target,
        input: {
          ...target.input,
          bootstrap: {
            createThread: {
              ...createThread,
              projectId: workspace === "conversation" ? null : createThread.projectId,
              worktreePath: workspace === "existing_worktree" ? "/worktrees/existing" : null,
            },
            ...(workspace === "worktree"
              ? {
                  prepareWorktree: { projectCwd: "/workspace", baseBranch: "main" },
                  runSetupScript: true,
                }
              : {}),
          },
        },
      };

      expect(await renderSend()(launch)).toMatchObject({ _tag: "Success" });
      expect(startTurn).toHaveBeenCalledExactlyOnceWith(launch);
      expect(appAtomRegistry.get(localThreadQueueAtom)).toEqual([]);
    },
  );

  it("sends an existing thread directly while its client projection is loading", async () => {
    const { bootstrap: _, ...input } = target.input;
    const followup = { ...target, input };
    expect(await renderSend()(followup)).toMatchObject({ _tag: "Success" });
    expect(startTurn).toHaveBeenCalledExactlyOnceWith(followup);
  });

  it("keeps pending offline messages ahead of new sends on the same environment", async () => {
    appAtomRegistry.set(localThreadQueueAtom, [pending]);
    // Cloud is unavailable in this test, so saved work must remain pending.
    expect(await renderSend()(target)).toMatchObject({ _tag: "Failure" });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it.each([
    { ...pending, environmentId: "other-environment" },
    { ...pending, threadId: "other-thread" },
    { ...pending, canceled: true },
  ])("does not wait for unrelated or canceled offline work", async (queued) => {
    appAtomRegistry.set(localThreadQueueAtom, [queued]);
    expect(await renderSend()(target)).toMatchObject({ _tag: "Success" });
    expect(startTurn).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("keeps cloud-saved messages ahead of a new send after reconnecting", async () => {
    appAtomRegistry.set(threadQueueRowsAtom, [
      {
        threadId: target.input.threadId,
        environmentId: target.environmentId,
        localProjectId: "project",
        cloudProjectId: null,
        title: "Pending work",
        launch: null,
        state: "queued",
        error: null,
        revision: 1,
        acceptedAt: null,
        queuedCount: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(await renderSend()(target)).toMatchObject({ _tag: "Failure" });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("reuses an uploaded file for a direct launch without requiring cloud sync", async () => {
    const metadata = {
      id: "composer-file",
      type: "file" as const,
      name: "context.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
    };
    vi.mocked(verifyReadyAttachmentUpload).mockResolvedValueOnce({
      status: "ready",
      environmentId: target.environmentId,
      attachmentId: "pending-file",
    });
    expect(
      await renderSend()({
        ...target,
        durableAttachments: [{ metadata, blob: null }],
      }),
    ).toMatchObject({ _tag: "Success" });
    expect(startTurn).toHaveBeenCalledExactlyOnceWith({
      ...target,
      input: {
        ...target.input,
        message: { ...target.input.message, attachments: [{ ...metadata, id: "pending-file" }] },
      },
    });
    expect(uploadStandaloneFileAttachment).not.toHaveBeenCalled();
  });

  it("rechecks connectivity after preparing attachments", async () => {
    vi.mocked(verifyReadyAttachmentUpload).mockImplementationOnce(async () => {
      appAtomRegistry.set(connection, AsyncResult.success({ phase: "disconnected" }));
      return null;
    });
    vi.mocked(uploadStandaloneFileAttachment).mockResolvedValueOnce({
      type: "file",
      id: "pending-file",
      name: "context.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
    });
    expect(
      await renderSend()({
        ...target,
        durableAttachments: [
          {
            metadata: {
              type: "file",
              id: "file",
              name: "context.txt",
              mimeType: "text/plain",
              sizeBytes: 7,
            },
            blob: new Blob(["context"]),
          },
        ],
      }),
    ).toMatchObject({ _tag: "Failure" });
    expect(uploadStandaloneFileAttachment).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("does not resend a direct launch through cloud when its acknowledgement is lost", async () => {
    startTurn.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(renderSend()(target)).rejects.toThrow("Connection lost");
    expect(startTurn).toHaveBeenCalledExactlyOnceWith(target);
    expect(appAtomRegistry.get(localThreadQueueAtom)).toEqual([]);
  });

  it("uses offline delivery when the environment is disconnected", async () => {
    appAtomRegistry.set(connection, AsyncResult.success({ phase: "disconnected" }));
    expect(await renderSend()(target)).toMatchObject({ _tag: "Failure" });
    expect(startTurn).not.toHaveBeenCalled();
  });
});
