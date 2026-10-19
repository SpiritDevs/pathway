import { assert, describe, it } from "@effect/vitest";

import {
  guessIssueStatusCategory,
  importedKeyPrefix,
  importedMaxKeyNumber,
  planIssueCsvImport,
} from "./csvImport.ts";

const LINEAR_EXPORT = [
  "ID,Team,Title,Description,Status,Estimate,Priority,Project,Assignee,Labels,Created,Updated,Due Date,Parent issue",
  'PAT-12,Pathway,Ship the tracker,"Body, with a comma",In Progress,3,High,Core,corey,"Bug, Chore",2026-08-01T09:00:00.000Z,2026-08-02T09:00:00.000Z,2026-09-01,',
  "PAT-13,Pathway,Sub-task,,Todo,,Low,,,,2026-08-01T10:00:00.000Z,,,PAT-12",
].join("\n");

describe("planIssueCsvImport", () => {
  it("maps the Linear export columns", () => {
    const plan = planIssueCsvImport(`${LINEAR_EXPORT}\n`);

    assert.deepStrictEqual(plan.skipped, []);
    assert.deepStrictEqual(plan.rows[0], {
      line: 2,
      key: "PAT-12",
      title: "Ship the tracker",
      description: "Body, with a comma",
      statusName: "In Progress",
      priority: "high",
      labelNames: ["Bug", "Chore"],
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-02T09:00:00.000Z",
      dueDate: "2026-09-01",
      parentKey: null,
    });
    assert.strictEqual(plan.rows[1]?.parentKey, "PAT-12");
    assert.strictEqual(plan.rows[1]?.priority, "low");
    assert.strictEqual(plan.rows[1]?.updatedAt, null);
  });

  it("matches headers case- and space-insensitively", () => {
    const plan = planIssueCsvImport("  TITLE ,  due  date ,PRIORITY\nOne,2026-01-02,Urgent\n");

    assert.deepStrictEqual(plan.rows, [
      {
        line: 2,
        key: null,
        title: "One",
        description: "",
        statusName: null,
        priority: "urgent",
        labelNames: [],
        createdAt: null,
        updatedAt: null,
        dueDate: "2026-01-02",
        parentKey: null,
      },
    ]);
  });

  it("skips malformed, short, titleless, and duplicate-key rows by line", () => {
    const plan = planIssueCsvImport(
      [
        "ID,Title,Status",
        "PAT-1,Good,Todo",
        'PAT-2,"quoted"junk,Todo',
        "PAT-3,Missing a column",
        "PAT-4,,Todo",
        "PAT-1,Repeat of one,Todo",
        "PAT-5,Also good,Todo",
      ].join("\n"),
    );

    assert.deepStrictEqual(
      plan.rows.map((row) => row.key),
      ["PAT-1", "PAT-5"],
    );
    assert.deepStrictEqual(plan.skipped, [
      { line: 3, reason: "Unbalanced quotes." },
      { line: 4, reason: "Expected 3 columns, found 2." },
      { line: 5, reason: "Missing title." },
      { line: 6, reason: "Duplicate key PAT-1 in this file." },
    ]);
  });

  it("reports the tail of the file as one row when a quote never closes", () => {
    // RFC 4180 leaves no other reading: everything after the opening quote is that field. One
    // skip naming the line the quote opened on is the only useful thing to say about it.
    const plan = planIssueCsvImport(
      'Title,Status\nGood,Todo\n"never closed,Todo\nAlso lost,Todo\n',
    );

    assert.deepStrictEqual(
      plan.rows.map((row) => row.title),
      ["Good"],
    );
    assert.deepStrictEqual(plan.skipped, [{ line: 3, reason: "Unbalanced quotes." }]);
  });

  it("allocates rather than skipping when the key column is not a key", () => {
    const plan = planIssueCsvImport("ID,Title\nnot-a-key,Still an issue\n");

    assert.strictEqual(plan.rows[0]?.key, null);
    assert.deepStrictEqual(plan.skipped, []);
  });

  it("refuses a header with no title column instead of skipping every row", () => {
    const plan = planIssueCsvImport("ID,Status\nPAT-1,Todo\nPAT-2,Todo\n");

    assert.deepStrictEqual(plan.rows, []);
    assert.deepStrictEqual(plan.skipped, [
      { line: 1, reason: "No Title column in the header row." },
    ]);
  });

  it("reads the prefix and the highest number off the preserved keys", () => {
    const { rows } = planIssueCsvImport("ID,Title\n,No key\nPAT-9,Nine\nPAT-204,Two oh four\n");

    assert.strictEqual(importedKeyPrefix(rows), "PAT");
    assert.strictEqual(importedMaxKeyNumber(rows), 204);
  });

  it("has no prefix or number to adopt when nothing carried a key", () => {
    const { rows } = planIssueCsvImport("Title\nOne\n");

    assert.strictEqual(importedKeyPrefix(rows), null);
    assert.strictEqual(importedMaxKeyNumber(rows), 0);
  });
});

describe("guessIssueStatusCategory", () => {
  it("reads a category out of the exported status name", () => {
    assert.strictEqual(guessIssueStatusCategory("Backlog"), "backlog");
    assert.strictEqual(guessIssueStatusCategory("Todo"), "unstarted");
    assert.strictEqual(guessIssueStatusCategory("In Progress"), "started");
    assert.strictEqual(guessIssueStatusCategory("In Review"), "review");
    assert.strictEqual(guessIssueStatusCategory("QA"), "review");
    assert.strictEqual(guessIssueStatusCategory("Done"), "completed");
    assert.strictEqual(guessIssueStatusCategory("Canceled"), "canceled");
    assert.strictEqual(guessIssueStatusCategory("Duplicate"), "canceled");
  });

  it("treats a name it has never seen as work not yet begun", () => {
    assert.strictEqual(guessIssueStatusCategory("Marinating"), "unstarted");
  });
});
