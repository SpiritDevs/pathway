import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "~/composerDraftStore";
import {
  issuesAssistantSurfaces,
  upsertIssuesAssistantIssueTab,
  type IssuesAssistantTab,
} from "./issuesAssistantPanel.logic";

const draftTab = {
  id: "thread:thread-1",
  kind: "draft",
  draftId: DraftId.make("draft-1"),
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  title: "ISS-27 + ISS-33",
} as const satisfies IssuesAssistantTab;

describe("issues assistant panel tabs", () => {
  it("maps conversations and issue details to peer right-panel surfaces", () => {
    const tabs = upsertIssuesAssistantIssueTab(
      [draftTab],
      "ISS-27",
      "The issue modal needs more room",
    );

    expect(issuesAssistantSurfaces(tabs)).toEqual([
      { id: "thread:thread-1", kind: "thread", resourceId: "thread-1" },
      {
        id: "issue:ISS-27",
        kind: "issue",
        issueKey: "ISS-27",
        title: "The issue modal needs more room",
      },
    ]);
  });

  it("reuses an open issue tab and refreshes its title", () => {
    const opened = upsertIssuesAssistantIssueTab([draftTab], "ISS-27", "Old title");
    const refreshed = upsertIssuesAssistantIssueTab(opened, "ISS-27", "Current title");

    expect(refreshed).toHaveLength(2);
    expect(refreshed[1]).toMatchObject({
      id: "issue:ISS-27",
      title: "Current title",
    });
  });
});
