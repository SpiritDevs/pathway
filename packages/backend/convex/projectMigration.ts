// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/**
 * Moving a company project, and everything filed against it, to another company.
 *
 * This is a migration rather than a field update. Statuses, labels, and issue keys are all owned by
 * the company, so an issue arriving in a new one has to be re-pointed at that company's workflow
 * values and re-keyed under its prefix. None of that is reversible — the original keys are gone —
 * so the caller states every mapping explicitly and this refuses anything it was not told how to
 * translate rather than guessing.
 *
 * Whole thing runs in one Convex transaction, so a project is never half-moved.
 *
 * @module projectMigration
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation } from "./_generated/server.js";
import { appendCompanyChanges, encodeCloudProject } from "./lib/companyApply.ts";
import { encodeIssue, encodeIssueMilestone } from "./lib/issueApply.ts";
import { backendError } from "./lib/errors.ts";
import { actorRecord, requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";
import { formatIssueKey, reserveIssueKeyBlock } from "../src/issueKeys.ts";

const idMapping = v.array(v.object({ from: domainIdArg, to: domainIdArg }));

function toMap(pairs: ReadonlyArray<{ from: string; to: string }>): ReadonlyMap<string, string> {
  return new Map(pairs.map((pair) => [pair.from, pair.to] as const));
}

/**
 * Confirms the caller may administer projects in both companies.
 *
 * Permission on the source alone would let a member push work into a company they only read.
 */
async function requireBothCompanies(ctx: MutationCtx, fromCompanyId: string, toCompanyId: string) {
  if (fromCompanyId === toCompanyId) {
    throw backendError("invalid-arguments", "The project is already in that company.");
  }
  const from = await requireCompanyActor(ctx, fromCompanyId);
  requirePermission(from, "projects.manage");
  const to = await requireCompanyActor(ctx, toCompanyId);
  requirePermission(to, "projects.manage");
  if (from.kind !== "member" || to.kind !== "member") {
    throw backendError("invalid-arguments", "An environment cannot move a project.");
  }
  return { from, to };
}

export const moveProjectToCompany = mutation({
  args: {
    fromCompanyId: domainIdArg,
    toCompanyId: domainIdArg,
    projectId: domainIdArg,
    /** Every status the moving issues use, mapped to one in the destination. */
    statusMapping: idMapping,
    /** Labels the moving issues carry. A label left out of this is dropped from its issues. */
    labelMapping: idMapping,
  },
  returns: v.object({
    movedIssues: v.number(),
    movedMilestones: v.number(),
    movedBindings: v.number(),
    droppedLabels: v.number(),
  }),
  handler: async (ctx, args) => {
    const { from, to } = await requireBothCompanies(ctx, args.fromCompanyId, args.toCompanyId);

    const project = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", from.company._id).eq("id", args.projectId),
      )
      .unique();
    if (project === null || project.deletedAt !== null) {
      throw backendError("entity-not-found", "That project is not in the source company.");
    }
    const clash = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", to.company._id).eq("id", args.projectId),
      )
      .unique();
    if (clash !== null) {
      throw backendError(
        "foreign-id-conflict",
        "That project id already exists in the destination.",
      );
    }

    const statusMap = toMap(args.statusMapping);
    const labelMap = toMap(args.labelMapping);

    const issues = (
      await ctx.db
        .query("issues")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", from.company._id).eq("projectId", args.projectId),
        )
        .collect()
    ).filter((issue) => issue.deletedAt === null);

    // Refuse before writing anything: a partial mapping discovered halfway would leave issues
    // pointing at a status their new company has never heard of.
    const unmapped = [...new Set(issues.map((issue) => issue.statusId))].filter(
      (statusId) => !statusMap.has(statusId),
    );
    if (unmapped.length > 0) {
      throw backendError(
        "invalid-arguments",
        `No destination chosen for ${unmapped.length} of this project's statuses.`,
      );
    }
    for (const [, targetId] of statusMap) {
      const target = await ctx.db
        .query("issueStatuses")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", to.company._id).eq("id", targetId),
        )
        .unique();
      if (target === null || target.deletedAt !== null) {
        throw backendError(
          "entity-not-found",
          "A chosen status is not in the destination company.",
        );
      }
    }

    const milestones = (
      await ctx.db
        .query("issueMilestones")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", from.company._id).eq("cloudProjectId", args.projectId),
        )
        .collect()
    ).filter((milestone) => milestone.deletedAt === null);

    const bindings = (
      await ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_environment", (q) => q.eq("companyId", from.company._id))
        .collect()
    ).filter((binding) => binding.cloudProjectId === project._id && binding.status !== "revoked");

    const now = Date.now();
    // One contiguous block so the moved issues read in their original order under the new prefix.
    const reservation = reserveIssueKeyBlock(
      to.company.nextIssueNumber,
      Math.max(1, issues.length),
    );
    await ctx.db.patch(to.company._id, {
      nextIssueNumber: reservation.nextIssueNumber,
      updatedAt: now,
    });

    const movingIssueIds = new Set(issues.map((issue) => issue.id));
    let droppedLabels = 0;

    const ordered = [...issues].sort((left, right) => left.keyNumber - right.keyNumber);
    for (const [index, issue] of ordered.entries()) {
      const keyNumber = reservation.block.blockStart + index;
      const labelIds: string[] = [];
      for (const labelId of issue.labelIds) {
        const mapped = labelMap.get(labelId);
        if (mapped === undefined) droppedLabels += 1;
        else labelIds.push(mapped);
      }
      await ctx.db.patch(issue._id, {
        companyId: to.company._id,
        statusId: statusMap.get(issue.statusId) ?? issue.statusId,
        labelIds,
        key: formatIssueKey(to.company.issueKeyPrefix, keyNumber),
        keyNumber,
        // Cycles span a whole company and do not travel with one project, so a moved issue leaves
        // its cycle behind rather than pointing at a cycle the new company does not have.
        cycleId: null,
        // A parent outside this project stays where it is, so the link would cross companies.
        parentId:
          issue.parentId !== null && movingIssueIds.has(issue.parentId) ? issue.parentId : null,
        // Teams are company-owned. The move lands the issue company-wide rather than inventing a
        // team membership nobody chose.
        teamIds: [],
        updatedAt: now,
      });
    }

    for (const milestone of milestones) {
      await ctx.db.patch(milestone._id, { companyId: to.company._id, updatedAt: now });
    }
    for (const binding of bindings) {
      await ctx.db.patch(binding._id, { companyId: to.company._id, updatedAt: now });
    }
    await ctx.db.patch(project._id, {
      companyId: to.company._id,
      teamIds: [],
      updatedAt: now,
    });

    await appendSourceTombstones(ctx, from.company._id, actorRecord(from), {
      project,
      issues: ordered,
      milestones,
    });
    await appendDestinationUpserts(ctx, to.company._id, actorRecord(to), {
      projectDocId: project._id,
      issueDocIds: ordered.map((issue) => issue._id),
      milestoneDocIds: milestones.map((milestone) => milestone._id),
    });

    return {
      movedIssues: ordered.length,
      movedMilestones: milestones.length,
      movedBindings: bindings.length,
      droppedLabels,
    };
  },
});

/** The source company's replicas must forget every row that left, or they keep serving stale work. */
async function appendSourceTombstones(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  actor: ReturnType<typeof actorRecord>,
  moved: {
    readonly project: Doc<"cloudProjects">;
    readonly issues: ReadonlyArray<Doc<"issues">>;
    readonly milestones: ReadonlyArray<Doc<"issueMilestones">>;
  },
): Promise<void> {
  await appendCompanyChanges(ctx, {
    companyId,
    actor,
    changes: [
      ...moved.issues.map((issue) => ({
        entityKind: "issue" as const,
        entityId: issue.id,
        changeKind: "tombstone" as const,
        versionDocId: issue._id,
        payload: null,
      })),
      ...moved.milestones.map((milestone) => ({
        entityKind: "issueMilestone" as const,
        entityId: milestone.id,
        changeKind: "tombstone" as const,
        versionDocId: milestone._id,
        payload: null,
      })),
      {
        entityKind: "cloudProject" as const,
        entityId: moved.project.id,
        changeKind: "tombstone" as const,
        versionDocId: moved.project._id,
        payload: null,
      },
    ],
  });
}

/**
 * Re-reads every moved row before encoding it.
 *
 * The rows were patched above and the source append bumped their `version` again, so encoding the
 * pre-move snapshots would publish the issue as it was, under its old key.
 */
async function appendDestinationUpserts(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  actor: ReturnType<typeof actorRecord>,
  moved: {
    readonly projectDocId: Id<"cloudProjects">;
    readonly issueDocIds: ReadonlyArray<Id<"issues">>;
    readonly milestoneDocIds: ReadonlyArray<Id<"issueMilestones">>;
  },
): Promise<void> {
  const company = await ctx.db.get(companyId);
  if (company === null) throw backendError("entity-not-found", "Destination company is missing.");

  const changes = [];
  const project = await ctx.db.get(moved.projectDocId);
  if (project !== null) {
    changes.push({
      entityKind: "cloudProject" as const,
      entityId: project.id,
      changeKind: "upsert" as const,
      versionDocId: project._id,
      payload: encodeCloudProject(project),
    });
  }
  for (const milestoneDocId of moved.milestoneDocIds) {
    const milestone = await ctx.db.get(milestoneDocId);
    if (milestone === null) continue;
    changes.push({
      entityKind: "issueMilestone" as const,
      entityId: milestone.id,
      changeKind: "upsert" as const,
      versionDocId: milestone._id,
      payload: encodeIssueMilestone(company, milestone),
    });
  }
  for (const issueDocId of moved.issueDocIds) {
    const issue = await ctx.db.get(issueDocId);
    if (issue === null) continue;
    changes.push({
      entityKind: "issue" as const,
      entityId: issue.id,
      changeKind: "upsert" as const,
      versionDocId: issue._id,
      payload: encodeIssue(company, issue),
    });
  }

  await appendCompanyChanges(ctx, { companyId, actor, changes });
}
