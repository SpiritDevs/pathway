import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  addProjectConnection,
  findReusableProjectConnection,
  type ProjectConnectionCheckout,
} from "./addProjectConnection.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-a");
const EXISTING_PROJECT_ID = ProjectId.make("existing-project");

function project(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: ENVIRONMENT_ID,
    id: EXISTING_PROJECT_ID,
    title: "QuoteCloud",
    titleIsCustom: false,
    workspaceRoot: "/Users/corey/GitHub/quotecloud-v2",
    repositoryIdentity: {
      canonicalKey: "github.com/corporate-interactive/quotecloud-v2",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/Corporate-Interactive/quotecloud-v2.git",
      },
      rootPath: "/Users/corey/GitHub/quotecloud-v2",
    },
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("project connection creation", () => {
  it("binds the server-normalized checkout before reporting success", async () => {
    const bindCheckout = vi.fn(async (_checkout: ProjectConnectionCheckout) => undefined);
    const outcome = await addProjectConnection({
      existingCheckout: null,
      createCheckout: vi.fn(async () => ({
        ok: true as const,
        value: {
          environmentId: ENVIRONMENT_ID,
          projectId: ProjectId.make("new-project"),
          title: "QuoteCloud",
          workspaceRoot: "/Users/corey/GitHub/quotecloud-v2",
          repositoryIdentity: null,
        },
      })),
      bindCheckout,
    });

    expect(outcome.ok).toBe(true);
    expect(bindCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "new-project",
        workspaceRoot: "/Users/corey/GitHub/quotecloud-v2",
      }),
    );
  });

  it("retries only the cloud binding after a local checkout was created", async () => {
    const checkout = project();
    const createCheckout = vi.fn(async () => ({
      ok: true as const,
      value: {
        environmentId: checkout.environmentId,
        projectId: checkout.id,
        title: checkout.title,
        workspaceRoot: checkout.workspaceRoot,
        repositoryIdentity: checkout.repositoryIdentity ?? null,
      },
    }));
    const bindCheckout = vi
      .fn<(checkout: ProjectConnectionCheckout) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce(undefined);

    const first = await addProjectConnection({
      existingCheckout: null,
      createCheckout,
      bindCheckout,
    });
    expect(first).toMatchObject({
      ok: false,
      message: "Network unavailable",
      checkout: { id: EXISTING_PROJECT_ID },
    });

    const second = await addProjectConnection({
      existingCheckout: first.ok ? null : first.checkout,
      createCheckout,
      bindCheckout,
    });
    expect(second.ok).toBe(true);
    expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(bindCheckout).toHaveBeenCalledTimes(2);
  });

  it("finds an existing checkout by repository when the entered path uses tilde", () => {
    expect(
      findReusableProjectConnection({
        projects: [project()],
        environmentId: ENVIRONMENT_ID,
        workspaceRoot: "~/GitHub/quotecloud-v2",
        repositoryKey: "github.com/corporate-interactive/quotecloud-v2",
      })?.id,
    ).toBe(EXISTING_PROJECT_ID);
  });
});
