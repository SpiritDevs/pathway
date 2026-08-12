import { afterEach, describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  completeProjectWorkspacePromptClose,
  readProjectWorkspacePromptState,
  registerProjectWorkspacePromptHost,
  requestProjectWorkspace,
  resetProjectWorkspacePromptForTests,
  respondToProjectWorkspacePrompt,
} from "./projectWorkspacePrompt";

const project = {
  environmentId: "env-1" as EnvironmentId,
  id: "proj-1" as ProjectId,
  title: "Tracker",
  workspaceRoot: null,
};
const otherProject = { ...project, id: "proj-2" as ProjectId, title: "Docs" };

afterEach(() => {
  resetProjectWorkspacePromptForTests();
});

describe("projectWorkspacePrompt", () => {
  it("resolves with null when no host is mounted, so a caller cannot hang", async () => {
    await expect(requestProjectWorkspace({ project, reason: null })).resolves.toBeNull();
  });

  it("resolves with the attached root", async () => {
    registerProjectWorkspacePromptHost();
    const pending = requestProjectWorkspace({ project, reason: "A terminal needs a directory." });
    expect(readProjectWorkspacePromptState()).toMatchObject({
      status: "prompting",
      request: { reason: "A terminal needs a directory." },
    });
    respondToProjectWorkspacePrompt({ workspaceRoot: "/code/tracker" });
    await expect(pending).resolves.toEqual({ workspaceRoot: "/code/tracker" });
  });

  it("resolves with null on a cancel", async () => {
    registerProjectWorkspacePromptHost();
    const pending = requestProjectWorkspace({ project, reason: null });
    respondToProjectWorkspacePrompt(null);
    await expect(pending).resolves.toBeNull();
  });

  it("queues a second request instead of racing two modals for one project", async () => {
    registerProjectWorkspacePromptHost();
    const first = requestProjectWorkspace({ project, reason: "first" });
    const second = requestProjectWorkspace({ project: otherProject, reason: "second" });
    expect(readProjectWorkspacePromptState()).toMatchObject({ request: { reason: "first" } });

    respondToProjectWorkspacePrompt({ workspaceRoot: "/a" });
    await expect(first).resolves.toEqual({ workspaceRoot: "/a" });
    // Still closing: the queued request only becomes active once the exit animation finishes.
    expect(readProjectWorkspacePromptState().status).toBe("closing");

    completeProjectWorkspacePromptClose();
    expect(readProjectWorkspacePromptState()).toMatchObject({
      status: "prompting",
      request: { reason: "second", project: { id: "proj-2" } },
    });
    respondToProjectWorkspacePrompt({ workspaceRoot: "/b" });
    await expect(second).resolves.toEqual({ workspaceRoot: "/b" });
  });

  it("cancels everything outstanding when the last host unmounts", async () => {
    const unregister = registerProjectWorkspacePromptHost();
    const first = requestProjectWorkspace({ project, reason: null });
    const second = requestProjectWorkspace({ project: otherProject, reason: null });
    unregister();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(readProjectWorkspacePromptState()).toEqual({ status: "idle" });
  });

  it("keeps prompting while a second host is still mounted", async () => {
    const unregisterFirst = registerProjectWorkspacePromptHost();
    registerProjectWorkspacePromptHost();
    const pending = requestProjectWorkspace({ project, reason: null });
    unregisterFirst();
    expect(readProjectWorkspacePromptState().status).toBe("prompting");
    respondToProjectWorkspacePrompt({ workspaceRoot: "/code" });
    await expect(pending).resolves.toEqual({ workspaceRoot: "/code" });
  });
});
