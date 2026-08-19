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
import {
  appendCompanyChanges,
  type CompanyChange,
  encodeAgentThread,
  encodeCapturedEmail,
  encodeCloudProject,
  encodeEnvironmentBinding,
  encodeEnvironmentCommand,
} from "./lib/companyApply.ts";
import {
  encodeIssue,
  encodeIssueAttachment,
  encodeIssueAuditEvent,
  encodeIssueComment,
  encodeIssueMilestone,
  encodeIssueRelation,
  encodeIssueThreadLink,
  encodeIssueTodo,
} from "./lib/issueApply.ts";
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

interface MovingIssueAssets {
  readonly todos: ReadonlyArray<Doc<"issueTodos">>;
  readonly comments: ReadonlyArray<Doc<"issueComments">>;
  readonly attachments: ReadonlyArray<Doc<"issueAttachments">>;
  readonly auditEvents: ReadonlyArray<Doc<"issueAuditEvents">>;
  readonly threadLinks: ReadonlyArray<Doc<"issueThreadLinks">>;
  readonly relations: ReadonlyArray<Doc<"issueRelations">>;
  readonly detachedRelations: ReadonlyArray<Doc<"issueRelations">>;
}

/** Collects every live row whose visibility and tenancy follow one of the moving issues. */
async function collectIssueAssets(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  issues: ReadonlyArray<Doc<"issues">>,
): Promise<MovingIssueAssets> {
  const todos: Doc<"issueTodos">[] = [];
  const comments: Doc<"issueComments">[] = [];
  const attachments: Doc<"issueAttachments">[] = [];
  const auditEvents: Doc<"issueAuditEvents">[] = [];
  const threadLinks: Doc<"issueThreadLinks">[] = [];
  const relationsById = new Map<string, Doc<"issueRelations">>();
  const movingIssueIds = new Set(issues.map((issue) => issue.id));

  for (const issue of issues) {
    const [issueTodos, issueComments, issueAttachments, issueAudits, issueLinks, from, to] =
      await Promise.all([
        ctx.db
          .query("issueTodos")
          .withIndex("by_company_issue_and_deleted", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id).eq("deletedAt", null),
          )
          .collect(),
        ctx.db
          .query("issueComments")
          .withIndex("by_company_issue_and_deleted", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id).eq("deletedAt", null),
          )
          .collect(),
        ctx.db
          .query("issueAttachments")
          .withIndex("by_company_issue_and_deleted", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id).eq("deletedAt", null),
          )
          .collect(),
        ctx.db
          .query("issueAuditEvents")
          .withIndex("by_company_and_issue", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id),
          )
          .collect(),
        ctx.db
          .query("issueThreadLinks")
          .withIndex("by_company_issue_and_deleted", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id).eq("deletedAt", null),
          )
          .collect(),
        ctx.db
          .query("issueRelations")
          .withIndex("by_company_issue_and_deleted", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id).eq("deletedAt", null),
          )
          .collect(),
        ctx.db
          .query("issueRelations")
          .withIndex("by_company_related_issue_and_deleted", (q) =>
            q.eq("companyId", companyId).eq("relatedIssueId", issue.id).eq("deletedAt", null),
          )
          .collect(),
      ]);
    todos.push(...issueTodos);
    comments.push(...issueComments);
    attachments.push(...issueAttachments);
    auditEvents.push(...issueAudits);
    threadLinks.push(...issueLinks);
    for (const relation of [...from, ...to]) relationsById.set(relation.id, relation);
  }

  const relations = [...relationsById.values()];
  return {
    todos,
    comments,
    attachments,
    auditEvents,
    threadLinks,
    relations: relations.filter(
      (relation) =>
        movingIssueIds.has(relation.issueId) && movingIssueIds.has(relation.relatedIssueId),
    ),
    // A relation cannot cross a company boundary. Preserve relations wholly inside the moving
    // project and tombstone every edge that would otherwise point back into the source company.
    detachedRelations: relations.filter(
      (relation) =>
        !movingIssueIds.has(relation.issueId) || !movingIssueIds.has(relation.relatedIssueId),
    ),
  };
}

function issueAssetCount(assets: MovingIssueAssets): number {
  return (
    assets.todos.length +
    assets.comments.length +
    assets.attachments.length +
    assets.auditEvents.length +
    assets.threadLinks.length +
    assets.relations.length +
    assets.detachedRelations.length
  );
}

async function moveIssueAssets(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  assets: MovingIssueAssets,
  now: number,
): Promise<void> {
  for (const row of assets.todos) {
    await ctx.db.patch(row._id, { companyId, updatedAt: now });
  }
  for (const row of assets.comments) {
    await ctx.db.patch(row._id, { companyId, updatedAt: now });
  }
  for (const row of assets.attachments) {
    await ctx.db.patch(row._id, { companyId, updatedAt: now });
  }
  for (const row of assets.auditEvents) {
    await ctx.db.patch(row._id, { companyId });
  }
  for (const row of assets.threadLinks) {
    await ctx.db.patch(row._id, { companyId });
  }
  for (const row of assets.relations) {
    await ctx.db.patch(row._id, { companyId });
  }
  for (const row of assets.detachedRelations) {
    await ctx.db.patch(row._id, { deletedAt: now });
  }
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
    movedThreads: v.number(),
    movedEmails: v.number(),
    movedIssueAssets: v.number(),
    canceledAutomationJobs: v.number(),
    detachedSlackWatches: v.number(),
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
    const movingIssueIds = new Set(issues.map((issue) => issue.id));

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

    const [
      milestones,
      bindings,
      commands,
      agentThreads,
      capturedEmails,
      automationJobs,
      slackWatches,
    ] = await Promise.all([
      ctx.db
        .query("issueMilestones")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", from.company._id).eq("cloudProjectId", args.projectId),
        )
        .collect()
        .then((rows) => rows.filter((row) => row.deletedAt === null)),
      ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", from.company._id).eq("cloudProjectId", project._id),
        )
        .collect()
        .then((rows) => rows.filter((row) => row.status !== "revoked")),
      ctx.db
        .query("environmentCommands")
        .withIndex("by_company", (q) => q.eq("companyId", from.company._id))
        .collect()
        .then((rows) => rows.filter((row) => row.cloudProjectId === project._id)),
      ctx.db
        .query("agentThreads")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", from.company._id).eq("cloudProjectId", project._id),
        )
        .collect(),
      ctx.db
        .query("capturedEmails")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", from.company._id).eq("cloudProjectId", project._id),
        )
        .collect(),
      ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_company", (q) => q.eq("companyId", from.company._id))
        .collect()
        .then((rows) =>
          rows.filter(
            (row) => movingIssueIds.has(row.issueId) || row.cloudProjectId === project._id,
          ),
        ),
      ctx.db
        .query("slackChannelWatches")
        .withIndex("by_company", (q) => q.eq("companyId", from.company._id))
        .collect()
        .then((rows) => rows.filter((row) => row.cloudProjectId === project._id)),
    ]);
    const issueAssets = await collectIssueAssets(ctx, from.company._id, issues);

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
        issueImportRunId: undefined,
        statusId: statusMap.get(issue.statusId) ?? issue.statusId,
        labelIds,
        key: formatIssueKey(to.company.issueKeyPrefix, keyNumber),
        keyNumber,
        // Cycles span a whole company and do not travel with one project, so a moved issue leaves
        // its cycle behind rather than pointing at a cycle the new company does not have.
        cycleId: null,
        // Slack integrations are company-owned and remain in the source company.
        slackSource: null,
        // A parent outside this project stays where it is, so the link would cross companies.
        parentId:
          issue.parentId !== null && movingIssueIds.has(issue.parentId) ? issue.parentId : null,
        // Teams are company-owned. The move lands the issue company-wide rather than inventing a
        // team membership nobody chose.
        teamIds: [],
        assignee: null,
        workflowOwner: { kind: "company" },
        automationAssignment: null,
        updatedAt: now,
      });
    }

    for (const milestone of milestones) {
      await ctx.db.patch(milestone._id, { companyId: to.company._id, updatedAt: now });
    }
    for (const binding of bindings) {
      await ctx.db.patch(binding._id, { companyId: to.company._id, updatedAt: now });
    }
    for (const command of commands) {
      const cancel = command.state === "pending" || command.state === "claimed";
      await ctx.db.patch(command._id, {
        companyId: to.company._id,
        ...(cancel
          ? {
              state: "canceled" as const,
              claimedByEnvironmentId: null,
              claimExpiresAt: null,
              error: "Canceled because the project moved to another company.",
            }
          : {}),
        updatedAt: now,
      });
    }
    for (const thread of agentThreads) {
      await ctx.db.patch(thread._id, { companyId: to.company._id, updatedAt: now });
    }
    for (const email of capturedEmails) {
      // Email tags belong to the source company. The capture moves, while its source-only labels
      // are cleared rather than becoming dangling references in the destination.
      await ctx.db.patch(email._id, { companyId: to.company._id, tagIds: [], updatedAt: now });
    }
    for (const job of automationJobs) {
      const isActive =
        job.state === "pending" ||
        job.state === "blocked" ||
        job.state === "claimed" ||
        job.state === "running";
      await ctx.db.patch(job._id, {
        companyId: to.company._id,
        ...(isActive
          ? {
              state: "canceled" as const,
              blockCode: null,
              diagnostic: "Canceled because the project moved to another company.",
              claimHolderEnvironmentId: null,
              claimExpiresAt: null,
              nextRetryAt: null,
              completedAt: now,
            }
          : {}),
        updatedAt: now,
      });
    }
    for (const watch of slackWatches) {
      // A Slack integration belongs to its source company and cannot follow one project. Keep the
      // channel watch there, but remove the cross-company project and cycle references.
      await ctx.db.patch(watch._id, {
        cloudProjectId: null,
        cycleId: null,
        revision: watch.revision + 1,
        updatedAt: now,
      });
    }
    await moveIssueAssets(ctx, to.company._id, issueAssets, now);
    await ctx.db.patch(project._id, {
      companyId: to.company._id,
      teamIds: [],
      defaultWorkflowOwner: null,
      updatedAt: now,
    });

    await appendSourceTombstones(ctx, from.company._id, actorRecord(from), {
      project,
      issues: ordered,
      milestones,
      bindings,
      commands,
      agentThreads,
      capturedEmails,
      issueAssets,
    });
    await appendDestinationUpserts(ctx, to.company._id, actorRecord(to), {
      projectDocId: project._id,
      issueDocIds: ordered.map((issue) => issue._id),
      milestoneDocIds: milestones.map((milestone) => milestone._id),
      bindingDocIds: bindings.map((binding) => binding._id),
      commandDocIds: commands.map((command) => command._id),
      agentThreadDocIds: agentThreads.map((thread) => thread._id),
      capturedEmailDocIds: capturedEmails.map((email) => email._id),
      issueAssets,
    });

    return {
      movedIssues: ordered.length,
      movedMilestones: milestones.length,
      movedBindings: bindings.length,
      movedThreads: agentThreads.length,
      movedEmails: capturedEmails.length,
      movedIssueAssets: issueAssetCount(issueAssets),
      canceledAutomationJobs: automationJobs.filter(
        (job) =>
          job.state === "pending" ||
          job.state === "blocked" ||
          job.state === "claimed" ||
          job.state === "running",
      ).length,
      detachedSlackWatches: slackWatches.length,
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
    readonly bindings: ReadonlyArray<Doc<"environmentBindings">>;
    readonly commands: ReadonlyArray<Doc<"environmentCommands">>;
    readonly agentThreads: ReadonlyArray<Doc<"agentThreads">>;
    readonly capturedEmails: ReadonlyArray<Doc<"capturedEmails">>;
    readonly issueAssets: MovingIssueAssets;
  },
): Promise<void> {
  const issueTeams = new Map(moved.issues.map((issue) => [issue.id, issue.teamIds] as const));
  const teamsForIssue = (issueId: string) => issueTeams.get(issueId) ?? [];
  const tombstone = (
    entityKind: CompanyChange["entityKind"],
    entityId: string,
    versionDocId: CompanyChange["versionDocId"],
    teamIds: readonly string[] = moved.project.teamIds,
  ): CompanyChange => ({
    entityKind,
    entityId,
    changeKind: "tombstone",
    teamIds,
    versionDocId,
    payload: null,
  });

  await appendCompanyChanges(ctx, {
    companyId,
    actor,
    changes: [
      ...moved.issueAssets.todos.map((row) =>
        tombstone("issueTodo", row.id, row._id, teamsForIssue(row.issueId)),
      ),
      ...moved.issueAssets.comments.map((row) =>
        tombstone("issueComment", row.id, row._id, teamsForIssue(row.issueId)),
      ),
      ...moved.issueAssets.attachments.map((row) =>
        tombstone("issueAttachment", row.id, row._id, teamsForIssue(row.issueId)),
      ),
      ...moved.issueAssets.auditEvents.map((row) =>
        tombstone("issueAuditEvent", row.id, row._id, teamsForIssue(row.issueId)),
      ),
      ...moved.issueAssets.threadLinks.map((row) =>
        tombstone("issueThreadLink", row.id, row._id, teamsForIssue(row.issueId)),
      ),
      ...[...moved.issueAssets.relations, ...moved.issueAssets.detachedRelations].map((row) =>
        tombstone("issueRelation", row.id, row._id, [
          ...new Set([...teamsForIssue(row.issueId), ...teamsForIssue(row.relatedIssueId)]),
        ]),
      ),
      ...moved.issues.map((issue) => tombstone("issue", issue.id, issue._id, issue.teamIds)),
      ...moved.milestones.map((row) => tombstone("issueMilestone", row.id, row._id)),
      ...moved.bindings.map((row) => tombstone("environmentBinding", row.id, row._id)),
      ...moved.commands.map((row) => tombstone("environmentCommand", row.id, row._id)),
      ...moved.agentThreads.map((row) => tombstone("agentThread", row.id, row._id)),
      ...moved.capturedEmails.map((row) => tombstone("capturedEmail", row.id, row._id)),
      tombstone("cloudProject", moved.project.id, moved.project._id),
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
    readonly bindingDocIds: ReadonlyArray<Id<"environmentBindings">>;
    readonly commandDocIds: ReadonlyArray<Id<"environmentCommands">>;
    readonly agentThreadDocIds: ReadonlyArray<Id<"agentThreads">>;
    readonly capturedEmailDocIds: ReadonlyArray<Id<"capturedEmails">>;
    readonly issueAssets: MovingIssueAssets;
  },
): Promise<void> {
  const company = await ctx.db.get(companyId);
  if (company === null) throw backendError("entity-not-found", "Destination company is missing.");

  const changes: CompanyChange[] = [];
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

  for (const docId of moved.bindingDocIds) {
    const row = await ctx.db.get(docId);
    if (row === null) continue;
    changes.push({
      entityKind: "environmentBinding",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: await encodeEnvironmentBinding(ctx, row),
    });
  }
  for (const docId of moved.commandDocIds) {
    const row = await ctx.db.get(docId);
    if (row === null) continue;
    changes.push({
      entityKind: "environmentCommand",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: await encodeEnvironmentCommand(ctx, row),
    });
  }
  for (const docId of moved.agentThreadDocIds) {
    const row = await ctx.db.get(docId);
    if (row === null) continue;
    changes.push({
      entityKind: "agentThread",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: await encodeAgentThread(ctx, row),
    });
  }
  for (const docId of moved.capturedEmailDocIds) {
    const row = await ctx.db.get(docId);
    if (row === null) continue;
    changes.push({
      entityKind: "capturedEmail",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: await encodeCapturedEmail(ctx, row),
    });
  }

  for (const before of moved.issueAssets.todos) {
    const row = await ctx.db.get(before._id);
    if (row === null) continue;
    changes.push({
      entityKind: "issueTodo",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: encodeIssueTodo(company, row),
    });
  }
  for (const before of moved.issueAssets.comments) {
    const row = await ctx.db.get(before._id);
    if (row === null) continue;
    changes.push({
      entityKind: "issueComment",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: encodeIssueComment(company, row),
    });
  }
  for (const before of moved.issueAssets.attachments) {
    const row = await ctx.db.get(before._id);
    if (row === null) continue;
    changes.push({
      entityKind: "issueAttachment",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: await encodeIssueAttachment(ctx, company, row),
    });
  }
  for (const before of moved.issueAssets.auditEvents) {
    const row = await ctx.db.get(before._id);
    if (row === null) continue;
    changes.push({
      entityKind: "issueAuditEvent",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: encodeIssueAuditEvent(company, row),
    });
  }
  for (const before of moved.issueAssets.threadLinks) {
    const row = await ctx.db.get(before._id);
    if (row === null) continue;
    changes.push({
      entityKind: "issueThreadLink",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: await encodeIssueThreadLink(ctx, company, row),
    });
  }
  for (const before of moved.issueAssets.relations) {
    const row = await ctx.db.get(before._id);
    if (row === null) continue;
    changes.push({
      entityKind: "issueRelation",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: row._id,
      payload: encodeIssueRelation(company, row),
    });
  }

  await appendCompanyChanges(ctx, { companyId, actor, changes });
}
