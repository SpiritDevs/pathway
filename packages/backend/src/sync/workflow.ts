/**
 * The effective workflow of one issue-workflow owner, and the row-shape rules the catalog rests on.
 *
 * A team's board is not a table read. It is the company base chain with that team's overrides
 * applied, that team's own statuses merged in, and the whole thing ordered by the one total order
 * the catalog uses everywhere. Every path that has to answer "what are the statuses of team X" —
 * placing a new issue, carrying an issue across a workflow-owner change, deciding where the issues
 * of a deleted status land — has to give the same answer, so the merge lives here once, pure and
 * unit-testable, and `convex/lib/issueApply` supplies the rows.
 *
 * The merge only makes sense if every stored row is one of exactly three things, which is what
 * {@link statusVariantViolation} enforces on the way in:
 *
 * - a **company base**: complete on its own (name, colour, category), overriding nothing;
 * - a **team override**: names a company base, unique per team and base, every field optional
 *   because an unset one keeps flowing from the base;
 * - a **team-only status**: complete on its own, part of no inheritance chain.
 *
 * @module sync/workflow
 */

/** The stored columns the merge reads, mirroring the `issueStatuses` table. */
export interface WorkflowStatusRow {
  readonly id: string;
  readonly scope: "company" | "team";
  readonly teamId: string | null;
  readonly baseStatusId: string | null;
  readonly name: string | null;
  readonly color: string | null;
  readonly category: string | null;
  readonly position: number | null;
  readonly hidden: boolean;
}

export type StatusVariant = "company-base" | "team-override" | "team-status";

export function statusVariant(row: {
  readonly scope: "company" | "team";
  readonly baseStatusId: string | null;
}): StatusVariant {
  if (row.scope === "company") return "company-base";
  return row.baseStatusId === null ? "team-status" : "team-override";
}

/**
 * Why this row is not a workflow status, or `null` when it is one. Applied on create *and* after
 * every patch: a base whose name was later nulled resolves into nothing a board can render, and an
 * override sitting on no base inherits from nothing at all.
 */
export function statusVariantViolation(row: WorkflowStatusRow): string | null {
  if (row.scope === "company") {
    if (row.teamId !== null) return "A company status carries no team.";
    if (row.baseStatusId !== null) {
      return "A company status is a base of its own and overrides nothing.";
    }
  } else if (row.teamId === null) {
    return "A team status names its team.";
  }
  // An override leaves the fields it does not set null on purpose: that is what keeps an untouched
  // company edit flowing into the team's workflow. Everything else stands alone and must be whole.
  if (statusVariant(row) === "team-override") return null;
  const missing: string[] = [];
  if (row.name === null) missing.push("name");
  if (row.color === null) missing.push("color");
  if (row.category === null) missing.push("category");
  if (missing.length === 0) return null;
  const subject = row.scope === "company" ? "A company status" : "A team's own status";
  return `${subject} carries its own ${missing.join(", ")}.`;
}

/** One column of a resolved workflow: what an issue sitting in it actually shows. */
export interface EffectiveStatus {
  /** The id an issue carries while it sits in this column — the override's, when there is one. */
  readonly id: string;
  /** The company base this column inherits from; `null` for a team-only status. */
  readonly baseId: string | null;
  readonly name: string | null;
  readonly color: string | null;
  readonly category: string | null;
  readonly position: number | null;
  readonly hidden: boolean;
}

/** Position ascending, nulls last, id tie-break — so an order is always total. */
function compareStatuses(a: EffectiveStatus, b: EffectiveStatus): number {
  const pa = a.position ?? Number.MAX_SAFE_INTEGER;
  const pb = b.position ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The ordered columns of one workflow. `companyBases` is every live company status; `teamRows` is
 * every live row of the owning team (its overrides and its own statuses), empty for the company
 * workflow itself.
 *
 * An override supplies the fields it sets and inherits the rest, including its position, which is
 * how a team renames a column without leaving the shared order. Its `hidden` flag wins outright:
 * the row exists precisely to state that team's visibility for the column. An override whose base
 * is gone resolves to nothing and is dropped — `issueStatus.delete` tombstones it in the same
 * transaction that removes the base, so this only ever hides a row mid-repair.
 */
export function mergeEffectiveWorkflow(
  companyBases: readonly WorkflowStatusRow[],
  teamRows: readonly WorkflowStatusRow[],
): readonly EffectiveStatus[] {
  const overrides = new Map<string, WorkflowStatusRow>();
  for (const row of teamRows) {
    const baseId = row.baseStatusId;
    if (baseId === null) continue;
    const held = overrides.get(baseId);
    // Two overrides of one base are refused on the way in; a pair that predates that check still
    // has to resolve the same way everywhere, so the lower id wins rather than the read order.
    if (held === undefined || row.id < held.id) overrides.set(baseId, row);
  }

  const merged: EffectiveStatus[] = [];
  for (const base of companyBases) {
    const override = overrides.get(base.id);
    merged.push(
      override === undefined
        ? {
            id: base.id,
            baseId: base.id,
            name: base.name,
            color: base.color,
            category: base.category,
            position: base.position,
            hidden: base.hidden,
          }
        : {
            id: override.id,
            baseId: base.id,
            name: override.name ?? base.name,
            color: override.color ?? base.color,
            category: override.category ?? base.category,
            position: override.position ?? base.position,
            hidden: override.hidden,
          },
    );
  }
  for (const row of teamRows) {
    if (row.baseStatusId !== null) continue;
    merged.push({
      id: row.id,
      baseId: null,
      name: row.name,
      color: row.color,
      category: row.category,
      position: row.position,
      hidden: row.hidden,
    });
  }
  merged.sort(compareStatuses);
  return merged;
}

/** The column an issue naming `statusId` sits in: its own id, or the base id it resolves through. */
export function effectiveStatusFor(
  workflow: readonly EffectiveStatus[],
  statusId: string,
): EffectiveStatus | null {
  return (
    workflow.find((status) => status.id === statusId) ??
    workflow.find((status) => status.baseId === statusId) ??
    null
  );
}

/** The first column a board shows; a workflow whose every column is hidden has none. */
export function firstVisibleStatus(workflow: readonly EffectiveStatus[]): EffectiveStatus | null {
  return workflow.find((status) => !status.hidden) ?? null;
}

export function firstVisibleInCategory(
  workflow: readonly EffectiveStatus[],
  category: string,
): EffectiveStatus | null {
  return workflow.find((status) => !status.hidden && status.category === category) ?? null;
}

/** What a status means independently of which row expresses it, for a carry-over. */
export interface StatusIdentity {
  /** The company base it inherits from, `null` for a team-only status. */
  readonly baseId: string | null;
  readonly category: string | null;
}

/**
 * Where an issue lands when its workflow owner changes, per the contract's
 * `SyncIssueSetWorkflowOwnerArgs`: the same inherited base when the target workflow still shows it,
 * otherwise the first visible target column in the same semantic category. `null` means neither
 * exists and the caller has to name a target explicitly.
 *
 * A column the target team hides is never a landing place — an issue carried into one would vanish
 * from the board that was supposed to receive it.
 */
export function carryOverStatusId(
  target: readonly EffectiveStatus[],
  current: StatusIdentity | null,
): string | null {
  if (current === null) return null;
  if (current.baseId !== null) {
    const inherited = target.find((status) => status.baseId === current.baseId);
    if (inherited !== undefined && !inherited.hidden) return inherited.id;
  }
  if (current.category !== null) {
    const sameCategory = firstVisibleInCategory(target, current.category);
    if (sameCategory !== null) return sameCategory.id;
  }
  return null;
}
