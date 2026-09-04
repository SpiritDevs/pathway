import { beforeEach, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@spiritdevs/contracts";
import { scopeProjectRef, scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { useComposerDraftStore, type ComposerAttachment } from "./composerDraftStore";
import { restoreWorkspacePreparationDraft } from "./workspacePreparationDraft";

const environmentId = EnvironmentId.make("review-environment");
const source = scopeThreadRef(environmentId, ThreadId.make("cancelled-thread"));
const projectRef = scopeProjectRef(environmentId, ProjectId.make("review-project"));
const thread = {
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  locations: ["agents" as const],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
};
const attachment = (id: string): ComposerAttachment => ({
  id,
  type: "file",
  name: `${id}.txt`,
  mimeType: "text/plain",
  sizeBytes: 4,
  previewUrl: "",
  file: new File(["test"], `${id}.txt`, { type: "text/plain" }),
});
beforeEach(() =>
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  }),
);

it("restores the submitted prompt and attachments into a new worktree draft", () => {
  const file = attachment("original");
  const draftId = restoreWorkspacePreparationDraft({
    source,
    projectRef,
    logicalProjectKey: "project",
    thread,
    preparation: { phase: "worktree", workspaceKind: "worktree", baseRef: "main" },
    text: "Original message",
    attachments: [file],
  });
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(draftId);
  expect(draft?.prompt).toBe("Original message");
  expect(draft?.images).toEqual([file]);
  expect(store.getDraftSession(draftId)).toMatchObject({
    branch: "main",
    worktreePath: null,
    envMode: "worktree",
  });
  expect(store.getDraftSession(draftId)?.threadId).not.toBe(source.threadId);
  expect(draft?.modelSelectionByProvider[thread.modelSelection.instanceId]).toEqual(
    thread.modelSelection,
  );
});

it("keeps text and attachments typed while the cancellation request was waiting", () => {
  const store = useComposerDraftStore.getState();
  const pending = attachment("pending");
  const original = attachment("original");
  store.setPrompt(source, "New pending text");
  store.addImages(source, [pending]);
  const draftId = restoreWorkspacePreparationDraft({
    source,
    projectRef,
    logicalProjectKey: "project",
    thread,
    preparation: undefined,
    text: "Submitted message",
    attachments: [original],
  });
  const restored = store.getComposerDraft(draftId);
  expect(restored?.prompt).toBe("Submitted message\n\nNew pending text");
  expect(restored?.images).toEqual([pending, original]);
  expect(store.getComposerDraft(source)?.prompt ?? "").toBe("");
  expect(store.getComposerDraft(source)?.images ?? []).toEqual([]);
});
