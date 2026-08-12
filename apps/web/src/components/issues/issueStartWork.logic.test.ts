import {
  IssueId,
  IssueStatusId,
  IssueTodoId,
  type Issue,
  type IssueTodo,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_PENDING_THREAD_LINK_STORAGE_KEY,
  buildIssueStartWorkPrompt,
  issueDetailPath,
  issueDetailUrl,
  issueStartWorkTodos,
  rememberPendingIssueThreadLink,
  takePendingIssueThreadLink,
  type PendingLinkStorage,
} from "./issueStartWork.logic";

const NOW = "2026-08-12T00:00:00.000Z";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId.make("i1"),
    key: "PAT-12",
    title: "Login test is flaky",
    description: "",
    statusId: IssueStatusId.make("todo"),
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

function todo(id: string, text: string, position: number, done = false): IssueTodo {
  return {
    id: IssueTodoId.make(id),
    issueId: IssueId.make("i1"),
    text,
    done,
    position,
  };
}

function memoryStorage(initial: Record<string, string> = {}): PendingLinkStorage & {
  readonly read: () => Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    read: () => Object.fromEntries(map),
  };
}

describe("issueDetailUrl", () => {
  it("points at the sheet over the list, because there is no per-issue route", () => {
    expect(issueDetailPath("PAT-12")).toBe("/issues?issue=PAT-12");
    expect(issueDetailUrl("http://localhost:5733", "PAT-12")).toBe(
      "http://localhost:5733/issues?issue=PAT-12",
    );
  });

  it("does not double a slash, and escapes a key that needs it", () => {
    expect(issueDetailUrl("http://localhost:5733/", "PAT-12")).toBe(
      "http://localhost:5733/issues?issue=PAT-12",
    );
    expect(issueDetailPath("A B")).toBe("/issues?issue=A%20B");
  });
});

describe("buildIssueStartWorkPrompt", () => {
  const base = {
    issue: issue(),
    statusName: "In Progress",
    projectTitle: "Pathway",
    priorityLabel: "High",
    todos: [],
    relations: [],
    issueUrl: "http://localhost:5733/issues?issue=PAT-12",
  };

  it("leads with the key and title, then the link and the metadata line", () => {
    const prompt = buildIssueStartWorkPrompt(base);
    const lines = prompt.split("\n");

    expect(lines[0]).toBe("# PAT-12 — Login test is flaky");
    expect(lines[2]).toBe("http://localhost:5733/issues?issue=PAT-12");
    expect(lines[3]).toBe("Status: In Progress · Priority: High · Project: Pathway");
  });

  it("drops every section it has nothing for", () => {
    const prompt = buildIssueStartWorkPrompt({
      ...base,
      statusName: null,
      projectTitle: null,
      priorityLabel: null,
    });

    expect(prompt).not.toContain("## Description");
    expect(prompt).not.toContain("## Checklist");
    expect(prompt).not.toContain("## Related");
    expect(prompt).not.toContain("Status:");
    expect(prompt.split("\n")[2]).toBe("http://localhost:5733/issues?issue=PAT-12");
  });

  it("writes todos as a checklist that keeps their done state", () => {
    const prompt = buildIssueStartWorkPrompt({
      ...base,
      todos: [todo("t1", "Reproduce it", 0, true), todo("t2", "Fix it", 1)],
    });

    expect(prompt).toContain("## Checklist\n- [x] Reproduce it\n- [ ] Fix it");
  });

  it("names each relation from this issue's end", () => {
    const prompt = buildIssueStartWorkPrompt({
      ...base,
      relations: [
        { label: "Blocked by", key: "PAT-3", title: "Auth rewrite" },
        { label: "Sub-issue of", key: "PAT-1", title: "Login epic" },
      ],
    });

    expect(prompt).toContain(
      "## Related\n- Blocked by: PAT-3 — Auth rewrite\n- Sub-issue of: PAT-1 — Login epic",
    );
  });

  it("carries a description verbatim and closes with the one instruction", () => {
    const prompt = buildIssueStartWorkPrompt({
      ...base,
      issue: issue({ description: "  It fails one run in ten.  " }),
    });

    expect(prompt).toContain("## Description\nIt fails one run in ten.");
    expect(prompt.trimEnd().endsWith("comment on it.")).toBe(true);
  });

  it("adds a due date to the metadata line when the issue has one", () => {
    const prompt = buildIssueStartWorkPrompt({ ...base, issue: issue({ dueDate: "2026-09-01" }) });
    expect(prompt).toContain("Due: 2026-09-01");
  });
});

describe("issueStartWorkTodos", () => {
  it("orders by position with the id breaking a tie", () => {
    const ordered = issueStartWorkTodos([
      todo("b", "second", 1),
      todo("a", "first", 0),
      todo("c", "also first", 0),
    ]);
    expect(ordered.map((each) => each.id)).toEqual(["a", "c", "b"]);
  });
});

describe("the pending link", () => {
  it("remembers an issue against a draft and spends it exactly once", () => {
    const storage = memoryStorage();
    rememberPendingIssueThreadLink(storage, "draft-1", IssueId.make("i1"));

    expect(takePendingIssueThreadLink(storage, "draft-1")).toBe("i1");
    expect(takePendingIssueThreadLink(storage, "draft-1")).toBe(null);
    // The last entry out clears the key rather than leaving `{}` behind.
    expect(storage.read()[ISSUE_PENDING_THREAD_LINK_STORAGE_KEY]).toBe(undefined);
  });

  it("keeps drafts apart, and the last press per draft wins", () => {
    const storage = memoryStorage();
    rememberPendingIssueThreadLink(storage, "draft-1", IssueId.make("i1"));
    rememberPendingIssueThreadLink(storage, "draft-2", IssueId.make("i2"));
    rememberPendingIssueThreadLink(storage, "draft-1", IssueId.make("i3"));

    expect(takePendingIssueThreadLink(storage, "draft-1")).toBe("i3");
    expect(takePendingIssueThreadLink(storage, "draft-2")).toBe("i2");
  });

  it("keeps only the newest entries, so an abandoned draft cannot grow the record", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 25; index += 1) {
      rememberPendingIssueThreadLink(storage, `draft-${index}`, IssueId.make(`i${index}`));
    }

    expect(takePendingIssueThreadLink(storage, "draft-0")).toBe(null);
    expect(takePendingIssueThreadLink(storage, "draft-24")).toBe("i24");
  });

  it("reads nothing out of junk, and nothing out of a storage that throws", () => {
    expect(
      takePendingIssueThreadLink(
        memoryStorage({ [ISSUE_PENDING_THREAD_LINK_STORAGE_KEY]: "not json" }),
        "draft-1",
      ),
    ).toBe(null);
    expect(
      takePendingIssueThreadLink(
        memoryStorage({ [ISSUE_PENDING_THREAD_LINK_STORAGE_KEY]: '["draft-1"]' }),
        "draft-1",
      ),
    ).toBe(null);

    const hostile: PendingLinkStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(takePendingIssueThreadLink(hostile, "draft-1")).toBe(null);
    expect(() =>
      rememberPendingIssueThreadLink(hostile, "draft-1", IssueId.make("i1")),
    ).not.toThrow();
  });
});
