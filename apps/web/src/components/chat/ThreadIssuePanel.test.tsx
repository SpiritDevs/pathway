import {
  IssueId,
  IssueStatusId,
  ThreadId,
  type Issue,
  type IssueStatus,
  type IssueThreadLink,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  links: [] as ReadonlyArray<IssueThreadLink>,
  issuesById: new Map(),
  statuses: [] as ReadonlyArray<IssueStatus>,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));
vi.mock("../issues/IssueDetailSheet", () => ({
  IssueDetailSheet: () => null,
}));
vi.mock("~/state/issues", () => ({
  useIssueLinksForThread: () => ({
    links: testState.links,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }),
  useIssue: (issueId: string | null) =>
    issueId === null ? null : (testState.issuesById.get(issueId) ?? null),
  useIssueStatuses: () => testState.statuses,
}));

import { ThreadIssuePanel } from "./ThreadIssuePanel";

const NOW = "2026-08-13T00:00:00.000Z";
const issue: Issue = {
  id: IssueId.make("issue-1"),
  key: "PAT-4",
  title: "Show issue context in the thread menu",
  description: "",
  statusId: IssueStatusId.make("status-started"),
  priority: "medium",
  assignee: null,
  projectId: null,
  milestoneId: null,
  cycleId: null,
  parentId: null,
  sortOrder: "m",
  labelIds: [],
  dueDate: "2026-08-20",
  triage: false,
  slackSource: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};
const status: IssueStatus = {
  id: issue.statusId,
  name: "In Progress",
  category: "started",
  color: "#f2c94c",
  position: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("ThreadIssuePanel", () => {
  beforeEach(() => {
    testState.links = [];
    testState.issuesById = new Map([[issue.id, issue]]);
    testState.statuses = [status];
    testState.navigate.mockReset();
  });

  it("shows the live issue summary for a thread started from an issue", () => {
    testState.links = [
      {
        issueId: issue.id,
        threadId: ThreadId.make("thread-1"),
        createdAt: NOW,
        origin: "start-work",
      },
    ];

    const html = renderToStaticMarkup(
      <ThreadIssuePanel threadId={ThreadId.make("thread-1")} enabled />,
    );

    expect(html).toContain("PAT-4");
    expect(html).toContain("Show issue context in the thread menu");
    expect(html).toContain("In Progress");
    expect(html).toContain("Medium");
    expect(html).toContain("2026-08-20");
    expect(html).toContain('aria-label="View issue PAT-4"');
  });

  it("does not treat a manually attached issue as the thread's origin", () => {
    testState.links = [
      {
        issueId: issue.id,
        threadId: ThreadId.make("thread-1"),
        createdAt: NOW,
        origin: "manual",
      },
    ];

    expect(
      renderToStaticMarkup(<ThreadIssuePanel threadId={ThreadId.make("thread-1")} enabled />),
    ).toBe("");
  });
});
