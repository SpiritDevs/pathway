import type { EnvironmentId, ThreadId } from "@spiritdevs/contracts";

import type { DraftId } from "~/composerDraftStore";
import type { RightPanelSurface } from "~/rightPanelStore";

export type IssuesAssistantTab =
  | {
      readonly id: `thread:${string}`;
      readonly kind: "draft";
      readonly draftId: DraftId;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly title: string;
    }
  | {
      readonly id: `issue:${string}`;
      readonly kind: "issue";
      readonly issueKey: string;
      readonly title: string;
    }
  | {
      readonly id: `thread:${string}`;
      readonly kind: "thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly title: string;
    };

export function issuesAssistantSurfaces(
  tabs: ReadonlyArray<IssuesAssistantTab>,
): RightPanelSurface[] {
  return tabs.map((tab) =>
    tab.kind === "draft" || tab.kind === "thread"
      ? {
          id: tab.id,
          kind: "thread",
          resourceId: tab.threadId,
        }
      : {
          id: tab.id,
          kind: "issue",
          issueKey: tab.issueKey,
          title: tab.title,
        },
  );
}

export function upsertIssuesAssistantIssueTab(
  tabs: ReadonlyArray<IssuesAssistantTab>,
  issueKey: string,
  title: string,
): ReadonlyArray<IssuesAssistantTab> {
  const id = `issue:${issueKey}` as const;
  const existing = tabs.find((tab) => tab.id === id);
  if (!existing) return [...tabs, { id, kind: "issue", issueKey, title }];
  if (existing.kind !== "issue" || existing.title === title) return tabs;
  return tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab));
}
