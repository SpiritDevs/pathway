import {
  IssueId,
  IssueStatusId,
  ThreadId,
  type Issue,
  type IssueStatus,
  type IssueThreadLink,
  type IssueThreadLinkOrigin,
} from "@t3tools/contracts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  links: [] as ReadonlyArray<IssueThreadLink>,
  issuesById: new Map<string, unknown>(),
  statuses: [] as ReadonlyArray<unknown>,
  navigate: vi.fn(),
  detailSheet: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));
vi.mock("../issues/IssueDetailSheet", () => ({
  IssueDetailSheet: (props: unknown) => {
    testState.detailSheet(props);
    return null;
  },
}));
vi.mock("~/state/issues", () => ({
  useIssueLinksForThread: () => ({
    links: testState.links,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }),
  useIssuesStore: () => ({ issuesById: testState.issuesById }),
  useIssueStatuses: () => testState.statuses,
}));

import { THREAD_ISSUE_PAGE_COUNT, ThreadIssuePanel, ThreadIssueRow } from "./ThreadIssuePanel";

const NOW = "2026-08-13T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function issue(id: string, overrides: Partial<Omit<Issue, "id">> = {}): Issue {
  return {
    id: IssueId.make(id),
    key: `PAT-${id}`,
    title: `Issue ${id}`,
    description: "",
    statusId: IssueStatusId.make("status-started"),
    priority: "none",
    assignee: null,
    projectId: null,
    milestoneId: null,
    cycleId: null,
    parentId: null,
    sortOrder: "m",
    labelIds: [],
    dueDate: null,
    triage: false,
    slackSource: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

const status: IssueStatus = {
  id: IssueStatusId.make("status-started"),
  name: "In Progress",
  category: "started",
  color: "#f2c94c",
  position: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

function link(issueId: string, origin: IssueThreadLinkOrigin, createdAt = NOW): IssueThreadLink {
  return { issueId: IssueId.make(issueId), threadId: THREAD_ID, createdAt, origin };
}

function storeOf(issues: ReadonlyArray<Issue>) {
  return new Map<string, unknown>(issues.map((value) => [value.id, value]));
}

function render() {
  return renderToStaticMarkup(<ThreadIssuePanel threadId={THREAD_ID} enabled />);
}

describe("ThreadIssuePanel", () => {
  beforeEach(() => {
    testState.links = [];
    testState.issuesById = new Map();
    testState.statuses = [status];
    testState.navigate.mockReset();
    testState.detailSheet.mockReset();
  });

  it("shows the live issue summary for a thread started from an issue", () => {
    testState.issuesById = storeOf([
      issue("4", {
        key: "PAT-4",
        title: "Show issue context in the thread menu",
        priority: "medium",
        dueDate: "2026-08-20",
      }),
    ]);
    testState.links = [link("4", "start-work")];

    const html = render();

    expect(html).toContain("PAT-4");
    expect(html).toContain("Show issue context in the thread menu");
    expect(html).toContain("In Progress");
    expect(html).toContain("Medium");
    expect(html).toContain("2026-08-20");
    expect(html).toContain('aria-label="View issue PAT-4"');
    expect(html).toContain("Issues");
    expect(html).toContain('aria-label="Issues linked to this thread"');
  });

  it("renders manual and mention links, not just the issue the thread came from", () => {
    testState.issuesById = storeOf([issue("1"), issue("2")]);
    testState.links = [link("1", "manual"), link("2", "mention", "2026-08-13T00:00:01.000Z")];

    const html = render();

    expect(html).toContain('aria-label="View issue PAT-1"');
    expect(html).toContain('aria-label="View issue PAT-2"');
  });

  it("orders rows by origin, start-work first and mention last", () => {
    testState.issuesById = storeOf([issue("1"), issue("2"), issue("3")]);
    testState.links = [
      link("1", "mention"),
      link("2", "manual", "2026-08-13T00:00:01.000Z"),
      link("3", "start-work", "2026-08-13T00:00:02.000Z"),
    ];

    const html = render();

    expect(html.indexOf("PAT-3")).toBeLessThan(html.indexOf("PAT-2"));
    expect(html.indexOf("PAT-2")).toBeLessThan(html.indexOf("PAT-1"));
  });

  it("renders one row per issue even when the same issue is linked twice", () => {
    testState.issuesById = storeOf([issue("1")]);
    testState.links = [
      link("1", "mention"),
      link("1", "start-work", "2026-08-13T00:00:01.000Z"),
      link("1", "manual", "2026-08-13T00:00:02.000Z"),
    ];

    const html = render();

    expect(html.split('aria-label="View issue PAT-1"')).toHaveLength(2);
  });

  // The number in the label is the number Show more adds, not the row list's own default.
  it("promises exactly the number of rows Show more reveals", () => {
    const issues = Array.from({ length: 40 }, (_value, index) => issue(String(index)));
    testState.issuesById = storeOf(issues);
    testState.links = issues.map((value, index) =>
      link(value.id, "mention", `2026-08-13T00:00:${String(index).padStart(2, "0")}.000Z`),
    );

    const html = render();

    expect(Number(/Show (\d+) more/.exec(html)?.[1])).toBe(THREAD_ISSUE_PAGE_COUNT);
  });

  it("keeps a soft-deleted issue on the list and says so", () => {
    testState.issuesById = storeOf([issue("1", { deletedAt: NOW })]);
    testState.links = [link("1", "mention")];

    const html = render();

    expect(html).toContain("Deleted");
    expect(html).toContain('aria-label="View issue PAT-1"');
  });

  it("drops a link whose issue is no longer in the store", () => {
    testState.issuesById = storeOf([issue("1")]);
    testState.links = [link("1", "manual"), link("purged", "mention")];

    const html = render();

    expect(html).toContain("PAT-1");
    expect(html).not.toContain("PAT-purged");
  });

  it("renders nothing when the thread has no issue links", () => {
    testState.issuesById = storeOf([issue("1")]);

    expect(render()).toBe("");
  });

  it("takes the title and status from the store rather than from the link", () => {
    testState.issuesById = storeOf([issue("1", { title: "Renamed since the link was made" })]);
    testState.statuses = [{ ...status, name: "In Review" }];
    testState.links = [link("1", "start-work")];

    const html = render();

    expect(html).toContain("Renamed since the link was made");
    expect(html).toContain("In Review");
  });

  it("keeps the detail sheet closed until a row is activated", () => {
    testState.issuesById = storeOf([issue("1")]);
    testState.links = [link("1", "start-work")];

    render();

    expect(testState.detailSheet).not.toHaveBeenCalled();
  });

  // No DOM in this project, so the row is driven through its element tree: the panel hands
  // `setOpenIssueKey` in as `onOpen`, which is what opens the sheet for that key.
  it("activating a row asks for that issue's key to be opened", () => {
    const onOpen = vi.fn();
    const row = ThreadIssueRow({ issue: issue("7"), meta: [], onOpen }) as ReactElement<{
      children: ReactElement<{ onClick: () => void }>;
    }>;

    row.props.children.props.onClick();

    expect(onOpen).toHaveBeenCalledWith("PAT-7");
  });
});
