import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  MILESTONE_HISTORY_MAX_DAYS,
  milestoneHistory,
  type MilestoneHistoryEvent,
  type MilestoneHistoryInput,
  type MilestoneHistoryMember,
} from "./milestoneHistory.ts";

const STATUSES = [
  { id: "todo", name: "Todo", category: "unstarted" as const },
  { id: "doing", name: "In Progress", category: "started" as const },
  { id: "reviewing", name: "In Review", category: "review" as const },
  { id: "done", name: "Done", category: "completed" as const },
  { id: "dropped", name: "Canceled", category: "canceled" as const },
];

const member = (id: string, statusId: string, createdOn: string): MilestoneHistoryMember => ({
  id,
  statusId,
  createdAt: `${createdOn}T09:00:00.000Z`,
});

const event = (
  issueId: string,
  field: string,
  before: string | null,
  after: string | null,
  on: string,
): MilestoneHistoryEvent => ({
  issueId,
  field,
  before,
  after,
  createdAt: `${on}T12:00:00.000Z`,
});

const UTC = DateTime.zoneMakeNamedUnsafe("UTC");

const history = (input: Partial<MilestoneHistoryInput>) =>
  milestoneHistory({
    milestone: { name: "Beta", startDate: "2026-03-01", targetDate: "2026-03-05" },
    members: [],
    events: [],
    statuses: STATUSES,
    today: "2026-03-05",
    zone: UTC,
    ...input,
  });

/** The series as `date scope/started/completed`, which is the whole assertion in most cases. */
const shape = (result: ReturnType<typeof milestoneHistory>) =>
  result.points.map((point) => `${point.date} ${point.scope}/${point.started}/${point.completed}`);

describe("milestoneHistory", () => {
  it("counts an issue created straight into the milestone from its creation day", () => {
    // No milestone event exists at all: this is exactly the case a forward replay would miss.
    const result = history({ members: [member("a", "todo", "2026-03-02")] });

    assert.deepStrictEqual(shape(result), [
      "2026-03-01 0/0/0",
      "2026-03-02 1/0/0",
      "2026-03-03 1/0/0",
      "2026-03-04 1/0/0",
      "2026-03-05 1/0/0",
    ]);
    assert.isFalse(result.approximate);
  });

  it("brings an issue into scope on the day it was moved in, not the day it was filed", () => {
    const result = history({
      members: [member("a", "doing", "2026-02-20")],
      events: [event("a", "milestone", null, "Beta", "2026-03-03")],
    });

    assert.deepStrictEqual(shape(result).slice(-4), [
      "2026-03-02 0/0/0",
      "2026-03-03 1/1/0",
      "2026-03-04 1/1/0",
      "2026-03-05 1/1/0",
    ]);
    // The range reaches back to the oldest member's creation day, ahead of the start date.
    assert.strictEqual(result.points[0]?.date, "2026-02-20");
  });

  it("drops an issue back out of scope for the stretch it spent in another milestone", () => {
    const result = history({
      members: [member("a", "todo", "2026-03-01")],
      events: [
        event("a", "milestone", null, "Beta", "2026-03-01"),
        event("a", "milestone", "Beta", "Alpha", "2026-03-02"),
        event("a", "milestone", "Alpha", "Beta", "2026-03-04"),
      ],
    });

    assert.deepStrictEqual(shape(result), [
      "2026-03-01 1/0/0",
      "2026-03-02 0/0/0",
      "2026-03-03 0/0/0",
      "2026-03-04 1/0/0",
      "2026-03-05 1/0/0",
    ]);
  });

  it("counts review as started but short of completed", () => {
    const result = history({
      members: [member("a", "reviewing", "2026-03-01")],
      events: [event("a", "status", "In Progress", "In Review", "2026-03-03")],
    });

    assert.deepStrictEqual(shape(result), [
      "2026-03-01 1/1/0",
      "2026-03-02 1/1/0",
      "2026-03-03 1/1/0",
      "2026-03-04 1/1/0",
      "2026-03-05 1/1/0",
    ]);
  });

  it("counts a canceled issue in scope and in neither started nor completed", () => {
    const result = history({
      members: [member("a", "dropped", "2026-03-01")],
      events: [event("a", "status", "In Progress", "Canceled", "2026-03-04")],
    });

    assert.deepStrictEqual(shape(result), [
      "2026-03-01 1/1/0",
      "2026-03-02 1/1/0",
      "2026-03-03 1/1/0",
      "2026-03-04 1/0/0",
      "2026-03-05 1/0/0",
    ]);
  });

  it("un-completes an issue that was reopened after it was finished", () => {
    const result = history({
      members: [member("a", "todo", "2026-03-01")],
      events: [
        event("a", "status", "Todo", "Done", "2026-03-02"),
        event("a", "status", "Done", "Todo", "2026-03-04"),
      ],
    });

    assert.deepStrictEqual(shape(result), [
      "2026-03-01 1/0/0",
      "2026-03-02 1/1/1",
      "2026-03-03 1/1/1",
      "2026-03-04 1/0/0",
      "2026-03-05 1/0/0",
    ]);
  });

  it("counts a status nobody carries any more as unstarted and flags the series approximate", () => {
    const result = history({
      members: [member("a", "done", "2026-03-01")],
      // "Shipping" was renamed to "Done" after the fact, so the log names a status that is gone.
      events: [event("a", "status", "Shipping", "Done", "2026-03-04")],
    });

    assert.isTrue(result.approximate);
    assert.deepStrictEqual(shape(result), [
      "2026-03-01 1/0/0",
      "2026-03-02 1/0/0",
      "2026-03-03 1/0/0",
      "2026-03-04 1/1/1",
      "2026-03-05 1/1/1",
    ]);
  });

  it("flags a renamed milestone rather than silently emptying its history", () => {
    const result = history({
      members: [member("a", "todo", "2026-03-01")],
      events: [event("a", "milestone", null, "Public Beta", "2026-03-03")],
    });

    assert.isTrue(result.approximate);
  });

  it("answers with nothing for an empty milestone that has no start date", () => {
    const result = history({ milestone: { name: "Beta", startDate: null, targetDate: null } });

    assert.deepStrictEqual(result.points, []);
    assert.isFalse(result.approximate);
  });

  it("draws a flat zero line for an empty milestone that has dates", () => {
    const result = history({});

    assert.deepStrictEqual(shape(result), [
      "2026-03-01 0/0/0",
      "2026-03-02 0/0/0",
      "2026-03-03 0/0/0",
      "2026-03-04 0/0/0",
      "2026-03-05 0/0/0",
    ]);
  });

  it("stops at today when the target date is still ahead", () => {
    const result = history({
      milestone: { name: "Beta", startDate: "2026-03-08", targetDate: "2026-04-01" },
      today: "2026-03-10",
    });

    assert.deepStrictEqual(shape(result), [
      "2026-03-08 0/0/0",
      "2026-03-09 0/0/0",
      "2026-03-10 0/0/0",
    ]);
  });

  it("answers with nothing when the milestone has not started yet", () => {
    const result = history({
      milestone: { name: "Beta", startDate: "2026-03-20", targetDate: "2026-04-01" },
    });

    assert.deepStrictEqual(result.points, []);
  });

  it("tracks several issues joining and finishing independently", () => {
    const result = history({
      milestone: { name: "Beta", startDate: "2026-03-01", targetDate: "2026-03-04" },
      members: [
        member("a", "done", "2026-03-01"),
        member("b", "doing", "2026-03-02"),
        member("c", "todo", "2026-02-25"),
      ],
      events: [
        event("a", "status", "Todo", "Done", "2026-03-03"),
        event("b", "status", "Todo", "In Progress", "2026-03-04"),
        event("c", "milestone", null, "Beta", "2026-03-04"),
      ],
    });

    assert.deepStrictEqual(shape(result).slice(-5), [
      "2026-03-01 1/0/0",
      "2026-03-02 2/0/0",
      "2026-03-03 2/1/1",
      "2026-03-04 3/2/1",
      "2026-03-05 3/2/1",
    ]);
  });

  it("keeps drawing past a target date that has gone by, where the finishing happened", () => {
    const result = history({
      milestone: { name: "Beta", startDate: "2026-03-01", targetDate: "2026-03-03" },
      members: [member("a", "done", "2026-03-01")],
      events: [event("a", "status", "Todo", "Done", "2026-03-05")],
    });

    assert.deepStrictEqual(shape(result), [
      "2026-03-01 1/0/0",
      "2026-03-02 1/0/0",
      "2026-03-03 1/0/0",
      "2026-03-04 1/0/0",
      "2026-03-05 1/1/1",
    ]);
  });

  it("still has a series when the target passed before the work was even filed", () => {
    const result = history({
      milestone: { name: "Beta", startDate: null, targetDate: "2026-01-10" },
      members: [member("a", "doing", "2026-03-03")],
    });

    assert.deepStrictEqual(shape(result), [
      "2026-03-03 1/1/0",
      "2026-03-04 1/1/0",
      "2026-03-05 1/1/0",
    ]);
  });

  it("buckets an evening edit on the day the server is having, not the day UTC is", () => {
    const result = history({
      milestone: { name: "Beta", startDate: "2026-03-04", targetDate: "2026-03-05" },
      members: [{ id: "a", statusId: "done", createdAt: "2026-03-04T17:00:00.000Z" }],
      // 17:30 on the 5th in Los Angeles, which UTC calls the small hours of the 6th.
      events: [
        {
          issueId: "a",
          field: "status",
          before: "Todo",
          after: "Done",
          createdAt: "2026-03-06T01:30:00.000Z",
        },
      ],
      zone: DateTime.zoneMakeNamedUnsafe("America/Los_Angeles"),
    });

    assert.deepStrictEqual(shape(result), ["2026-03-04 1/0/0", "2026-03-05 1/1/1"]);
  });

  it("caps a long-running milestone at the most recent year of days", () => {
    const result = history({
      milestone: { name: "Beta", startDate: "2020-01-01", targetDate: null },
      members: [member("a", "todo", "2019-06-01")],
    });

    assert.strictEqual(result.points.length, MILESTONE_HISTORY_MAX_DAYS);
    assert.strictEqual(result.points.at(-1)?.date, "2026-03-05");
    // The clamped first day still reports the truth for that day: backward replay reads each day
    // from the present rather than from the point before it.
    assert.deepStrictEqual(result.points[0], {
      date: "2025-03-05",
      scope: 1,
      started: 0,
      completed: 0,
    });
  });
});
