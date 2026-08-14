import { describe, expect, it } from "vite-plus/test";

import {
  auditEventDomainId,
  defaultIssueSortOrder,
  derivedDomainId,
  ISSUE_TITLE_MAX_CHARS,
  issueKeyNumber,
  orderKeyAfter,
  parseIssueCreateArgs,
  parseIssuePatchArgs,
  parseIssueStatusCreateArgs,
  parseIssueViewCreateArgs,
  parseNoArgs,
  type ArgsResult,
} from "./issueOps.ts";

function expectRejected(result: ArgsResult<unknown>, fragment: string): void {
  if (result.ok) throw new Error(`expected a refusal mentioning ${fragment}`);
  expect(result.message).toContain(fragment);
}

describe("parseIssueCreateArgs", () => {
  it("accepts a minimal create and leaves every optional field undefined", () => {
    const result = parseIssueCreateArgs({ title: "Fix the crash" });
    expect(result).toMatchObject({ ok: true, args: { title: "Fix the crash" } });
    if (result.ok) {
      expect(result.args.statusId).toBeUndefined();
      expect(result.args.teamIds).toBeUndefined();
      expect(result.args.priority).toBeUndefined();
    }
  });

  it("accepts the full shape", () => {
    const result = parseIssueCreateArgs({
      key: "PAT-42",
      title: "Fix the crash",
      description: "Steps to reproduce…",
      statusId: "status-1",
      priority: "urgent",
      assignee: { kind: "member", membershipId: "member-1" },
      projectId: "project-1",
      labelIds: ["label-1", "label-2"],
      dueDate: "2026-08-14",
      triage: false,
      sortOrder: "a5",
      teamIds: ["team-1"],
      workflowOwner: { kind: "team", teamId: "team-1" },
      workModelSelection: { model: "default" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.key).toBe("PAT-42");
      expect(result.args.assignee).toEqual({ kind: "member", membershipId: "member-1" });
      expect(result.args.workflowOwner).toEqual({ kind: "team", teamId: "team-1" });
    }
  });

  it("refuses a non-object, naming the envelope field", () => {
    expectRejected(parseIssueCreateArgs("nope"), "args");
    expectRejected(parseIssueCreateArgs(null), "args");
  });

  it("refuses an empty or untrimmed title", () => {
    expectRejected(parseIssueCreateArgs({ title: "" }), "args.title");
    expectRejected(parseIssueCreateArgs({ title: " padded " }), "args.title");
  });

  it("refuses a title past the ceiling", () => {
    expectRejected(
      parseIssueCreateArgs({ title: "x".repeat(ISSUE_TITLE_MAX_CHARS + 1) }),
      "args.title",
    );
  });

  it("refuses a malformed key, priority, date, and assignee", () => {
    expectRejected(parseIssueCreateArgs({ title: "T", key: "pat-1" }), "args.key");
    expectRejected(parseIssueCreateArgs({ title: "T", priority: "asap" }), "args.priority");
    expectRejected(parseIssueCreateArgs({ title: "T", dueDate: "tomorrow" }), "args.dueDate");
    expectRejected(parseIssueCreateArgs({ title: "T", assignee: { kind: "robot" } }), "assignee");
  });
});

describe("parseIssuePatchArgs", () => {
  it("keeps three states apart: absent, explicit null, and a value", () => {
    const result = parseIssuePatchArgs({ projectId: null, title: "New title" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.projectId).toBeNull();
      expect(result.args.title).toBe("New title");
      expect(result.args.milestoneId).toBeUndefined();
    }
  });

  it("refuses null for a field that cannot be cleared", () => {
    expectRejected(parseIssuePatchArgs({ title: null }), "args.title");
    expectRejected(parseIssuePatchArgs({ statusId: null }), "args.statusId");
  });
});

describe("parseIssueStatusCreateArgs", () => {
  it("accepts a company status and a team status", () => {
    expect(parseIssueStatusCreateArgs({ scope: "company", name: "Todo" }).ok).toBe(true);
    expect(parseIssueStatusCreateArgs({ scope: "team", teamId: "team-1" }).ok).toBe(true);
  });

  it("refuses an unknown scope and a bad category", () => {
    expectRejected(parseIssueStatusCreateArgs({ scope: "global" }), "args.scope");
    expectRejected(
      parseIssueStatusCreateArgs({ scope: "company", category: "later" }),
      "args.category",
    );
  });
});

describe("parseIssueViewCreateArgs", () => {
  const config = { tab: "active", grouping: "status", sortMode: "manual", viewMode: "list" };

  it("accepts a view with a minimal config", () => {
    expect(parseIssueViewCreateArgs({ name: "My view", config }).ok).toBe(true);
  });

  it("refuses a config with a bad chip", () => {
    expectRejected(
      parseIssueViewCreateArgs({ name: "My view", config: { ...config, dueFilter: "someday" } }),
      "dueFilter",
    );
  });
});

describe("parseNoArgs", () => {
  it("accepts an empty object, null, and undefined", () => {
    expect(parseNoArgs({})).toEqual({ ok: true, args: {} });
    expect(parseNoArgs(null)).toEqual({ ok: true, args: {} });
    expect(parseNoArgs(undefined)).toEqual({ ok: true, args: {} });
  });

  it("refuses anything with content, so a client that meant to send arguments hears about it", () => {
    expectRejected(parseNoArgs({ title: "T" }), "no arguments");
  });
});

describe("derivedDomainId", () => {
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

  it("is UUIDv7-shaped, deterministic, and distinct across seeds", () => {
    const one = derivedDomainId("op-1:audit:0");
    expect(one).toMatch(UUID_SHAPE);
    expect(derivedDomainId("op-1:audit:0")).toBe(one);
    expect(derivedDomainId("op-2:audit:0")).not.toBe(one);
  });

  it("does not repeat one 32-bit hash across its segments", () => {
    const id = derivedDomainId("op-1:audit:0");
    const head = id.slice(0, 8);
    expect(id.slice(9)).not.toContain(head);
  });
});

describe("auditEventDomainId", () => {
  it("separates events of one operation by index", () => {
    expect(auditEventDomainId("op-1", 0)).not.toBe(auditEventDomainId("op-1", 1));
    expect(auditEventDomainId("op-1", 0)).toBe(auditEventDomainId("op-1", 0));
  });
});

describe("ordering helpers", () => {
  it("defaultIssueSortOrder sorts by key number", () => {
    expect(defaultIssueSortOrder(2) > defaultIssueSortOrder(1)).toBe(true);
    expect(defaultIssueSortOrder(10) > defaultIssueSortOrder(9)).toBe(true);
  });

  it("orderKeyAfter always sorts after its input", () => {
    expect(orderKeyAfter(null) > "").toBe(true);
    const last = defaultIssueSortOrder(3);
    expect(orderKeyAfter(last) > last).toBe(true);
  });

  it("issueKeyNumber reads the numeric half", () => {
    expect(issueKeyNumber("PAT-42")).toBe(42);
    expect(issueKeyNumber("A2B-7")).toBe(7);
  });
});
