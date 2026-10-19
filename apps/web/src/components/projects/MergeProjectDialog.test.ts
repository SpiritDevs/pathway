import { describe, expect, it } from "vite-plus/test";

import { mergeProjectRepositoryChoices } from "./MergeProjectDialog";
import type { WorkspaceProject } from "./workspaceProjects.logic";

describe("merge project repository choices", () => {
  it("keeps the cloud repository available while every checkout is offline", () => {
    const staleCloudIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/SpiritDevs/pathway.git",
      },
    };
    const currentBindingIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway-next",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/SpiritDevs/pathway-next.git",
      },
    };
    const project: WorkspaceProject = {
      projectKey: "cloud:pathway",
      displayName: "Pathway",
      companyIds: ["company"],
      group: null,
      checkoutCount: 0,
      cloudProjectId: "pathway",
      repositoryIdentity: staleCloudIdentity,
      repositoryIdentities: [currentBindingIdentity],
    };

    expect(mergeProjectRepositoryChoices([project])).toEqual([
      currentBindingIdentity,
      staleCloudIdentity,
    ]);
  });
});
