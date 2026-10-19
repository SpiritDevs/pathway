import { describe, expect, it } from "vite-plus/test";

import {
  carryOverStatusId,
  effectiveStatusFor,
  firstVisibleInCategory,
  firstVisibleStatus,
  mergeEffectiveWorkflow,
  statusVariant,
  statusVariantViolation,
  type WorkflowStatusRow,
} from "./workflow.ts";

const row = (
  overrides: Partial<WorkflowStatusRow> & { readonly id: string },
): WorkflowStatusRow => ({
  scope: "company",
  teamId: null,
  baseStatusId: null,
  name: "Todo",
  color: "#3b82f6",
  category: "unstarted",
  position: 0,
  hidden: false,
  ...overrides,
});

describe("statusVariant", () => {
  it("tells the three shapes apart by scope and base", () => {
    expect(statusVariant({ scope: "company", baseStatusId: null })).toBe("company-base");
    expect(statusVariant({ scope: "team", baseStatusId: "base" })).toBe("team-override");
    expect(statusVariant({ scope: "team", baseStatusId: null })).toBe("team-status");
  });
});

describe("statusVariantViolation", () => {
  it("accepts a complete company base", () => {
    expect(statusVariantViolation(row({ id: "s1" }))).toBeNull();
  });

  it("refuses a company status that overrides another", () => {
    expect(statusVariantViolation(row({ id: "s1", baseStatusId: "s0" }))).toContain("overrides");
  });

  it("refuses a company status carrying a team", () => {
    expect(statusVariantViolation(row({ id: "s1", teamId: "team-a" }))).toContain("no team");
  });

  it("refuses a base or team-only status missing what a board renders", () => {
    expect(statusVariantViolation(row({ id: "s1", color: null }))).toContain("color");
    expect(
      statusVariantViolation(row({ id: "s1", scope: "team", teamId: "team-a", category: null })),
    ).toContain("category");
  });

  it("accepts an override that sets nothing, because the base supplies it all", () => {
    expect(
      statusVariantViolation(
        row({
          id: "s2",
          scope: "team",
          teamId: "team-a",
          baseStatusId: "s1",
          name: null,
          color: null,
          category: null,
          position: null,
        }),
      ),
    ).toBeNull();
  });

  it("refuses a team row with no team", () => {
    expect(statusVariantViolation(row({ id: "s1", scope: "team", teamId: null }))).toContain(
      "names its team",
    );
  });
});

describe("mergeEffectiveWorkflow", () => {
  const backlog = row({ id: "base-backlog", name: "Backlog", category: "backlog", position: 0 });
  const doing = row({ id: "base-doing", name: "Doing", category: "started", position: 1 });
  const done = row({ id: "base-done", name: "Done", category: "completed", position: 2 });

  it("inherits every untouched field of the base, including its position", () => {
    const override = row({
      id: "team-doing",
      scope: "team",
      teamId: "team-a",
      baseStatusId: "base-doing",
      name: "In progress",
      color: null,
      category: null,
      position: null,
    });
    const merged = mergeEffectiveWorkflow([backlog, doing, done], [override]);
    expect(merged.map((status) => status.id)).toEqual(["base-backlog", "team-doing", "base-done"]);
    expect(merged[1]).toMatchObject({
      baseId: "base-doing",
      name: "In progress",
      color: "#3b82f6",
      category: "started",
      position: 1,
    });
  });

  it("lets the override decide visibility outright", () => {
    const hidden = row({
      id: "team-done",
      scope: "team",
      teamId: "team-a",
      baseStatusId: "base-done",
      name: null,
      color: null,
      category: null,
      position: null,
      hidden: true,
    });
    const merged = mergeEffectiveWorkflow([backlog, done], [hidden]);
    expect(firstVisibleStatus(merged)?.id).toBe("base-backlog");
    expect(firstVisibleInCategory(merged, "completed")).toBeNull();
  });

  it("merges the team's own statuses into the same order", () => {
    const own = row({
      id: "team-review",
      scope: "team",
      teamId: "team-a",
      name: "Review",
      category: "review",
      position: 1,
    });
    const merged = mergeEffectiveWorkflow([backlog, done], [own]);
    expect(merged.map((status) => status.id)).toEqual(["base-backlog", "team-review", "base-done"]);
  });

  it("drops an override whose base is gone rather than inventing a column", () => {
    const orphan = row({
      id: "team-ghost",
      scope: "team",
      teamId: "team-a",
      baseStatusId: "vanished",
      name: null,
      color: null,
      category: null,
      position: null,
    });
    expect(mergeEffectiveWorkflow([backlog], [orphan]).map((s) => s.id)).toEqual(["base-backlog"]);
  });

  it("resolves a duplicated override by id, not by read order", () => {
    const first = row({
      id: "team-a1",
      scope: "team",
      teamId: "team-a",
      baseStatusId: "base-doing",
      name: "First",
      color: null,
      category: null,
      position: null,
    });
    const second = { ...first, id: "team-a2", name: "Second" };
    expect(mergeEffectiveWorkflow([doing], [second, first])[0]).toMatchObject({
      id: "team-a1",
      name: "First",
    });
  });
});

describe("effectiveStatusFor", () => {
  const workflow = mergeEffectiveWorkflow(
    [row({ id: "base-doing", name: "Doing", category: "started", position: 0 })],
    [
      row({
        id: "team-doing",
        scope: "team",
        teamId: "team-a",
        baseStatusId: "base-doing",
        name: "In progress",
        color: null,
        category: null,
        position: null,
      }),
    ],
  );

  it("answers to the column's own id and to the base it resolves through", () => {
    expect(effectiveStatusFor(workflow, "team-doing")?.id).toBe("team-doing");
    expect(effectiveStatusFor(workflow, "base-doing")?.id).toBe("team-doing");
    expect(effectiveStatusFor(workflow, "elsewhere")).toBeNull();
  });
});

describe("carryOverStatusId", () => {
  const target = mergeEffectiveWorkflow(
    [
      row({ id: "base-doing", name: "Doing", category: "started", position: 0 }),
      row({ id: "base-done", name: "Done", category: "completed", position: 1 }),
    ],
    [
      row({
        id: "team-doing",
        scope: "team",
        teamId: "team-b",
        baseStatusId: "base-doing",
        name: "Shipping",
        color: null,
        category: null,
        position: null,
      }),
    ],
  );

  it("reuses the inherited base under the target team's own id", () => {
    expect(carryOverStatusId(target, { baseId: "base-doing", category: "started" })).toBe(
      "team-doing",
    );
  });

  it("falls back to the first visible target column in the same category", () => {
    expect(
      carryOverStatusId(target, { baseId: "team-only-elsewhere", category: "completed" }),
    ).toBe("base-done");
  });

  it("never lands an issue in a column the target team hides", () => {
    const hiding = mergeEffectiveWorkflow(
      [row({ id: "base-doing", name: "Doing", category: "started", position: 0 })],
      [
        row({
          id: "team-doing",
          scope: "team",
          teamId: "team-b",
          baseStatusId: "base-doing",
          name: null,
          color: null,
          category: null,
          position: null,
          hidden: true,
        }),
      ],
    );
    expect(carryOverStatusId(hiding, { baseId: "base-doing", category: "started" })).toBeNull();
  });

  it("asks for an explicit target when neither identity nor category matches", () => {
    expect(carryOverStatusId(target, { baseId: "elsewhere", category: "canceled" })).toBeNull();
    expect(carryOverStatusId(target, null)).toBeNull();
  });
});
