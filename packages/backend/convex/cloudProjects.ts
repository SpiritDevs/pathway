// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Online administration for company-owned projects and their environment-local bindings. */
import { v } from "convex/values";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, internalMutation } from "./_generated/server.js";
import {
  appendCompanyChanges,
  encodeAgentThread,
  encodeCapturedEmail,
  encodeCloudProject,
  encodeEnvironmentBinding,
  encodeEnvironmentCommand,
  type CompanyChange,
} from "./lib/companyApply.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  requireCompanyActor,
  requirePermission,
  requireRecordPermission,
} from "./lib/identity.ts";
import { encodeIssue, encodeIssueMilestone, encodeIssueView } from "./lib/issueApply.ts";
import { domainIdArg, repositoryIdentityArg } from "./lib/validators.ts";
import { measureSerializedBytes } from "../src/sync/changeFeed.ts";

function trimmed(value: string, label: string): string {
  const result = value.trim();
  if (result.length === 0) throw backendError("invalid-arguments", `${label} is required.`);
  return result;
}

/** Keeps a merge comfortably below Convex's single-transaction read/write limits. */
const PROJECT_MERGE_MAX_AFFECTED_ROWS = 300;
const PROJECT_MERGE_MAX_COMPANY_SCAN_ROWS = 2_000;
const PROJECT_MERGE_MAX_SERIALIZED_BYTES = 4 * 1_024 * 1_024;
// These records can each approach half a megabyte. Their query caps keep the read itself bounded
// before the byte-aware aggregate check below can inspect the returned documents.
const PROJECT_MERGE_MAX_COMMAND_ROWS = 8;
const PROJECT_MERGE_MAX_CAPTURED_EMAIL_ROWS = 5;
const PROJECT_MERGE_ISSUE_VIEW_PAGE_SIZE = 50;

type StoredRepositoryIdentity = NonNullable<Doc<"environmentBindings">["repositoryIdentity"]>;

function sameRepositoryIdentity(
  left: StoredRepositoryIdentity,
  right: StoredRepositoryIdentity,
): boolean {
  return (
    left.canonicalKey === right.canonicalKey &&
    left.locator.source === right.locator.source &&
    left.locator.remoteName === right.locator.remoteName &&
    left.locator.remoteUrl === right.locator.remoteUrl
  );
}

/** Empty is company-wide, so it absorbs every narrower team scope. */
function mergedProjectTeamIds(
  sourceTeamIds: ReadonlyArray<string>,
  targetTeamIds: ReadonlyArray<string>,
): string[] {
  return sourceTeamIds.length === 0 || targetTeamIds.length === 0
    ? []
    : [...new Set([...targetTeamIds, ...sourceTeamIds])];
}

function projectTeamScopeWidened(
  previousTeamIds: ReadonlyArray<string>,
  nextTeamIds: ReadonlyArray<string>,
): boolean {
  if (previousTeamIds.length === 0) return false;
  if (nextTeamIds.length === 0) return true;
  const previous = new Set(previousTeamIds);
  return nextTeamIds.some((teamId) => !previous.has(teamId));
}

function assertBoundedProjectMergeRows(label: string, count: number, maximum: number): void {
  if (count <= maximum) return;
  throw backendError(
    "invalid-arguments",
    `This merge affects too many ${label} for one safe transaction. Reduce the project data or contact support.`,
  );
}

function assertBoundedProjectMergeBytes(rows: Iterable<unknown>): void {
  let bytes = 0;
  for (const row of rows) {
    // Each affected document is both patched and represented in the change feed. Counting it twice
    // is intentionally conservative and keeps one large payload from exhausting the transaction.
    bytes += measureSerializedBytes(row) * 2;
    if (bytes <= PROJECT_MERGE_MAX_SERIALIZED_BYTES) continue;
    throw backendError(
      "invalid-arguments",
      "This merge contains too much serialized project data for one safe transaction. Reduce the project data or contact support.",
    );
  }
}

async function collectActiveProjectCommands(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  cloudProjectId: Id<"cloudProjects">,
): Promise<ReadonlyArray<Doc<"environmentCommands">>> {
  const pending = await ctx.db
    .query("environmentCommands")
    .withIndex("by_company_project_and_state", (q) =>
      q.eq("companyId", companyId).eq("cloudProjectId", cloudProjectId).eq("state", "pending"),
    )
    .take(PROJECT_MERGE_MAX_COMMAND_ROWS + 1);
  if (pending.length > PROJECT_MERGE_MAX_COMMAND_ROWS) return pending;
  const claimed = await ctx.db
    .query("environmentCommands")
    .withIndex("by_company_project_and_state", (q) =>
      q.eq("companyId", companyId).eq("cloudProjectId", cloudProjectId).eq("state", "claimed"),
    )
    .take(PROJECT_MERGE_MAX_COMMAND_ROWS - pending.length + 1);
  return [...pending, ...claimed];
}

interface ProjectIssueData {
  readonly issues: ReadonlyArray<Doc<"issues">>;
  readonly todos: ReadonlyArray<Doc<"issueTodos">>;
  readonly comments: ReadonlyArray<Doc<"issueComments">>;
  readonly attachments: ReadonlyArray<Doc<"issueAttachments">>;
  readonly auditEvents: ReadonlyArray<Doc<"issueAuditEvents">>;
  readonly threadLinks: ReadonlyArray<Doc<"issueThreadLinks">>;
  readonly relations: ReadonlyArray<Doc<"issueRelations">>;
  readonly childrenToDetach: ReadonlyArray<Doc<"issues">>;
}

/** Reads every row whose lifetime follows an issue filed in one project. */
async function collectProjectIssueData(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  projectId: string,
): Promise<ProjectIssueData> {
  const issues = await ctx.db
    .query("issues")
    .withIndex("by_company_and_project", (q) =>
      q.eq("companyId", companyId).eq("projectId", projectId),
    )
    .collect();
  const issueIds = new Set(issues.map((issue) => issue.id));
  const todos: Doc<"issueTodos">[] = [];
  const comments: Doc<"issueComments">[] = [];
  const attachments: Doc<"issueAttachments">[] = [];
  const auditEvents: Doc<"issueAuditEvents">[] = [];
  const threadLinks: Doc<"issueThreadLinks">[] = [];
  const relationsByDocId = new Map<Id<"issueRelations">, Doc<"issueRelations">>();

  for (const issue of issues) {
    const [issueTodos, issueComments, issueAttachments, issueAudits, issueLinks, from, to] =
      await Promise.all([
        ctx.db
          .query("issueTodos")
          .withIndex("by_company_and_issue", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id),
          )
          .collect(),
        ctx.db
          .query("issueComments")
          .withIndex("by_company_and_issue", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id),
          )
          .collect(),
        ctx.db
          .query("issueAttachments")
          .withIndex("by_company_and_issue", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id),
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
          .withIndex("by_company_and_issue", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id),
          )
          .collect(),
        ctx.db
          .query("issueRelations")
          .withIndex("by_company_and_issue", (q) =>
            q.eq("companyId", companyId).eq("issueId", issue.id),
          )
          .collect(),
        ctx.db
          .query("issueRelations")
          .withIndex("by_company_and_related_issue", (q) =>
            q.eq("companyId", companyId).eq("relatedIssueId", issue.id),
          )
          .collect(),
      ]);
    todos.push(...issueTodos);
    comments.push(...issueComments);
    attachments.push(...issueAttachments);
    auditEvents.push(...issueAudits);
    threadLinks.push(...issueLinks);
    for (const relation of [...from, ...to]) relationsByDocId.set(relation._id, relation);
  }

  const childrenToDetach = (
    await ctx.db
      .query("issues")
      .withIndex("by_company_and_version", (q) => q.eq("companyId", companyId))
      .collect()
  ).filter(
    (issue) =>
      issue.deletedAt === null &&
      issue.parentId !== null &&
      issueIds.has(issue.parentId) &&
      !issueIds.has(issue.id),
  );

  return {
    issues,
    todos,
    comments,
    attachments,
    auditEvents,
    threadLinks,
    relations: [...relationsByDocId.values()],
    childrenToDetach,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Removes routes that specifically target a deleted project while preserving unrelated routes. */
function withoutProjectReactionRoutes(
  trigger: unknown,
  projectId: string,
  disableDefaultRoutes: boolean,
): { readonly trigger: unknown; readonly changed: boolean } {
  const value = record(trigger);
  if (value === null || !Array.isArray(value["reactionRoutes"])) {
    return { trigger, changed: false };
  }
  const reactionRoutes = value["reactionRoutes"].filter(
    (route) => record(route)?.["cloudProjectId"] !== projectId,
  );
  const defaultRoutesChanged =
    disableDefaultRoutes && (value["everyMessage"] === true || value["botMention"] === true);
  if (reactionRoutes.length === value["reactionRoutes"].length && !defaultRoutesChanged) {
    return { trigger, changed: false };
  }
  return {
    trigger: {
      ...value,
      reactionRoutes,
      ...(disableDefaultRoutes ? { everyMessage: false, botMention: false } : {}),
    },
    changed: true,
  };
}

function withoutProjectRoutingRules(
  rules: unknown,
  projectId: string,
): { readonly rules: unknown; readonly changed: boolean } {
  if (!Array.isArray(rules)) return { rules, changed: false };
  const remaining = rules.filter((rule) => record(rule)?.["cloudProjectId"] !== projectId);
  return { rules: remaining, changed: remaining.length !== rules.length };
}

function replaceProjectReactionRoutes(
  trigger: unknown,
  fromProjectId: string,
  toProjectId: string,
) {
  const value = record(trigger);
  if (value === null || !Array.isArray(value["reactionRoutes"])) return trigger;
  let changed = false;
  const reactionRoutes = value["reactionRoutes"].map((route) => {
    const routeValue = record(route);
    if (routeValue?.["cloudProjectId"] !== fromProjectId) return route;
    changed = true;
    return { ...routeValue, cloudProjectId: toProjectId };
  });
  if (!changed) return trigger;
  return {
    ...value,
    reactionRoutes,
  };
}

function replaceProjectRoutingRules(rules: unknown, fromProjectId: string, toProjectId: string) {
  if (!Array.isArray(rules)) return rules;
  let changed = false;
  const updated = rules.map((rule) => {
    const ruleValue = record(rule);
    if (ruleValue?.["cloudProjectId"] !== fromProjectId) return rule;
    changed = true;
    return { ...ruleValue, cloudProjectId: toProjectId };
  });
  return changed ? updated : rules;
}

function replaceIssueViewProjectIds(config: unknown, fromProjectId: string, toProjectId: string) {
  const value = record(config);
  if (value === null || !Array.isArray(value["projectIds"])) return config;
  const projectIds = value["projectIds"];
  if (!projectIds.includes(fromProjectId)) return config;
  return {
    ...value,
    projectIds: [
      ...new Set(
        projectIds.map((projectId) => (projectId === fromProjectId ? toProjectId : projectId)),
      ),
    ],
  };
}

/** Retargets saved views outside the merge transaction, one bounded company page at a time. */
export const retargetMergedProjectIssueViews = internalMutation({
  args: {
    companyId: v.id("companies"),
    sourceProjectId: domainIdArg,
    targetProjectId: domainIdArg,
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const company = await ctx.db.get(args.companyId);
    if (company === null) return null;
    const page = await ctx.db
      .query("issueViews")
      .withIndex("by_company_and_visibility", (q) => q.eq("companyId", args.companyId))
      .paginate({ cursor: args.cursor, numItems: PROJECT_MERGE_ISSUE_VIEW_PAGE_SIZE });
    const changes: CompanyChange[] = [];
    for (const view of page.page) {
      if (view.deletedAt !== null) continue;
      const config = replaceIssueViewProjectIds(
        view.config,
        args.sourceProjectId,
        args.targetProjectId,
      );
      if (config === view.config) continue;
      await ctx.db.patch(view._id, { config, updatedAt: Date.now() });
      const updated = await ctx.db.get(view._id);
      if (updated === null) continue;
      changes.push({
        entityKind: "issueView",
        entityId: updated.id,
        changeKind: "upsert",
        teamIds: updated.visibility === "teams" ? updated.teamIds : [],
        versionDocId: updated._id,
        payload: await encodeIssueView(ctx, company, updated),
      });
    }
    if (changes.length > 0) {
      await appendCompanyChanges(ctx, {
        companyId: args.companyId,
        actor: { kind: "system", source: "automation" },
        changes,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.cloudProjects.retargetMergedProjectIssueViews, {
        ...args,
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

function hasSlackRoutes(configurationVersion: 2 | undefined, trigger: unknown, rules: unknown) {
  if (configurationVersion === 2) return Array.isArray(rules) && rules.length > 0;
  const value = record(trigger);
  return (
    value !== null &&
    (value["everyMessage"] === true ||
      value["botMention"] === true ||
      (Array.isArray(value["reactionRoutes"]) && value["reactionRoutes"].length > 0))
  );
}

async function deleteProjectFocusAssignments(
  ctx: MutationCtx,
  bindings: ReadonlyArray<Doc<"environmentBindings">>,
): Promise<void> {
  const projectKeys = new Set(
    bindings.map((binding) => `${binding.environmentId}:${binding.localProjectId}`),
  );
  for (const projectKey of projectKeys) {
    const assignments = await ctx.db
      .query("focusAssignments")
      .withIndex("by_project", (q) => q.eq("projectKey", projectKey))
      .collect();
    for (const assignment of assignments) await ctx.db.delete(assignment._id);
  }
}

/**
 * Creates a company project that no machine has a checkout of yet.
 *
 * A project is company-owned (ADR 0011): it exists to plan against, and a checkout is something
 * you attach later, on as many machines as you like, or never. Unlike `ensureEnvironmentProject`
 * this mints a fresh domain id rather than borrowing a local project id, because there is no local
 * project to borrow from.
 */
export const createCompanyProject = mutation({
  args: {
    companyId: domainIdArg,
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: domainIdArg,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const name = trimmed(args.name, "A project name");

    const now = Date.now();
    const projectDocId = await ctx.db.insert("cloudProjects", {
      id: mintDomainId(now),
      companyId: actor.company._id,
      name,
      description: args.description?.trim() ?? "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      repositoryIdentity: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const project = await ctx.db.get(projectDocId);
    if (project === null) throw backendError("entity-not-found", "The project insert vanished.");

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "cloudProject" as const,
          entityId: project.id,
          changeKind: "upsert" as const,
          versionDocId: project._id,
          payload: encodeCloudProject(project),
        },
      ],
    });
    return project.id;
  },
});

/**
 * Gives a company a project a machine already has a checkout of, and binds that checkout to it.
 *
 * The local project id is deliberately reused as the cloud id. That keeps issue associations
 * stable on the originating environment, while the binding records the machine-specific root.
 *
 * Ownership does not wait for the checkout. A project belongs to a company (ADR 0011) and a
 * checkout is something attached to it, so an environment this company has not registered costs
 * you the binding, not the project: the project lands, and the binding follows when that
 * environment registers and republishes. Gating the whole call on the registration made a project
 * unassignable from every machine except the one holding it.
 *
 * `allowCreate` defaults to true. Reconciliation passes false: it refreshes projects this company
 * already owns but must never mint ownership, because an environment registered with several
 * companies would otherwise copy every checkout into each of them. Only an explicit assignment —
 * the assign dialog or an issue flow — creates a company project for a checkout.
 */
export const ensureEnvironmentProject = mutation({
  args: {
    companyId: domainIdArg,
    cloudProjectId: v.optional(domainIdArg),
    environmentId: v.string(),
    localProjectId: v.string(),
    localWorkspaceRoot: v.union(v.string(), v.null()),
    repositoryIdentity: v.optional(v.union(repositoryIdentityArg, v.null())),
    matchRepository: v.optional(v.boolean()),
    name: v.string(),
    allowCreate: v.optional(v.boolean()),
  },
  returns: v.union(domainIdArg, v.null()),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const environmentId = trimmed(args.environmentId, "An environment id");
    const localProjectId = trimmed(args.localProjectId, "A local project id");
    const name = trimmed(args.name, "A project name");
    const localWorkspaceRoot =
      args.localWorkspaceRoot === null
        ? null
        : trimmed(args.localWorkspaceRoot, "A local workspace root");
    const repositoryIdentity = args.repositoryIdentity;
    const repositoryKey = repositoryIdentity?.canonicalKey ?? null;
    const explicitCloudProjectId = args.cloudProjectId;

    const registration = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
      )
      .unique();
    // A binding asserts "this company's project is checked out on that machine, at that path".
    // Only an environment the company has admitted may make that claim, so an unregistered one
    // takes the project and leaves the binding for later.
    const environmentRegistered = registration !== null && registration.state === "active";

    const explicitProject =
      explicitCloudProjectId === undefined
        ? null
        : await ctx.db
            .query("cloudProjects")
            .withIndex("by_company_and_domain_id", (q) =>
              q.eq("companyId", actor.company._id).eq("id", explicitCloudProjectId),
            )
            .unique();
    if (explicitCloudProjectId !== undefined) {
      if (explicitProject === null || explicitProject.deletedAt !== null) {
        throw backendError("entity-not-found", "The company project is no longer available.");
      }
      if (!environmentRegistered) {
        throw backendError(
          "environment-not-registered",
          "Register this environment with the company before attaching its checkout.",
        );
      }
    }

    let binding: Doc<"environmentBindings"> | null = !environmentRegistered
      ? null
      : ((
          await ctx.db
            .query("environmentBindings")
            .withIndex("by_company_and_environment", (q) =>
              q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
            )
            .collect()
        ).find((row) => row.localProjectId === localProjectId && row.status !== "revoked") ?? null);
    let project = binding === null ? null : await ctx.db.get(binding.cloudProjectId);
    if (project === null && repositoryKey !== null && args.matchRepository !== false) {
      const repositoryBindings = await ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_repository", (q) =>
          q.eq("companyId", actor.company._id).eq("repositoryKey", repositoryKey),
        )
        .collect();
      for (const candidate of repositoryBindings.toSorted((left, right) => {
        const leftActive = left.status === "active" ? 1 : 0;
        const rightActive = right.status === "active" ? 1 : 0;
        return rightActive - leftActive || right.updatedAt - left.updatedAt;
      })) {
        const candidateProject = await ctx.db.get(candidate.cloudProjectId);
        if (candidateProject !== null && candidateProject.deletedAt === null) {
          project = candidateProject;
          break;
        }
      }
    }
    if (explicitProject !== null) {
      if (project !== null && project._id !== explicitProject._id) {
        throw backendError(
          "foreign-id-conflict",
          "This checkout is already bound to another company project.",
        );
      }
      project = explicitProject;
    }
    project ??= await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", localProjectId),
      )
      .unique();
    const now = Date.now();
    let projectChanged = false;
    if (project === null) {
      // A project lives in exactly one company (ADR 0011). Another company this environment is
      // registered with may already own this checkout; adopting it here would mirror the project
      // into two companies. Report the owner's id and bind nothing in this company.
      const foreignBinding = (
        await ctx.db
          .query("environmentBindings")
          .withIndex("by_environment", (q) => q.eq("environmentId", environmentId))
          .collect()
      ).find(
        (row) =>
          row.localProjectId === localProjectId &&
          row.status !== "revoked" &&
          row.companyId !== actor.company._id,
      );
      const foreignProject =
        foreignBinding === undefined ? null : await ctx.db.get(foreignBinding.cloudProjectId);
      if (foreignProject !== null && foreignProject.deletedAt === null) {
        return foreignProject.id;
      }
      if (args.allowCreate === false) return null;

      const projectDocId = await ctx.db.insert("cloudProjects", {
        id: localProjectId,
        companyId: actor.company._id,
        name,
        description: "",
        teamIds: [],
        defaultWorkflowOwner: null,
        preferredBindingId: null,
        repositoryIdentity: repositoryIdentity ?? null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      project = await ctx.db.get(projectDocId);
      if (project === null) throw backendError("entity-not-found", "The project insert vanished.");
      projectChanged = true;
    } else if (project.deletedAt !== null) {
      // A local checkout can be offline when its company project is deleted. Its publisher will
      // offer the still-live local row again when that environment reconnects, before the inbound
      // replica necessarily gets a turn to remove it. The Convex tombstone is authoritative: an
      // outbound observation may never resurrect a project the company already deleted.
      return project.id;
    } else if (
      project.name !== name ||
      project.archivedAt !== null ||
      ((project.repositoryIdentity === undefined || project.repositoryIdentity === null) &&
        repositoryIdentity != null)
    ) {
      await ctx.db.patch(project._id, {
        name,
        archivedAt: null,
        ...((project.repositoryIdentity === undefined || project.repositoryIdentity === null) &&
        repositoryIdentity != null
          ? { repositoryIdentity }
          : {}),
        updatedAt: now,
      });
      project = await ctx.db.get(project._id);
      if (project === null) throw backendError("entity-not-found", "The project vanished.");
      projectChanged = true;
    }

    let bindingChanged = false;

    if (binding !== null && binding.cloudProjectId !== project._id) {
      throw backendError(
        "foreign-id-conflict",
        "This local project is already bound to another cloud project.",
      );
    }

    if (environmentRegistered && binding === null && localWorkspaceRoot !== null) {
      const bindingDocId = await ctx.db.insert("environmentBindings", {
        id: mintDomainId(now),
        companyId: actor.company._id,
        cloudProjectId: project._id,
        environmentId,
        localProjectId,
        localWorkspaceRoot,
        ...(repositoryIdentity === undefined ? {} : { repositoryIdentity, repositoryKey }),
        status: "active",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      binding = await ctx.db.get(bindingDocId);
      if (binding === null) throw backendError("entity-not-found", "The project binding vanished.");
      bindingChanged = true;
      if (project.preferredBindingId === null) {
        await ctx.db.patch(project._id, { preferredBindingId: binding.id, updatedAt: now });
        project = await ctx.db.get(project._id);
        if (project === null) throw backendError("entity-not-found", "The project vanished.");
        projectChanged = true;
      }
    } else if (
      binding !== null &&
      (binding.localWorkspaceRoot !== localWorkspaceRoot ||
        binding.status !== (localWorkspaceRoot === null ? "missing" : "active") ||
        // A null identity means the environment's enrichment has not resolved (yet), not that the
        // checkout lost its repository: the publisher re-reports every project each minute, and
        // treating null as authoritative made each expired enrichment cache clear the stored
        // identity, then restore it a minute later — a permanent write/feed ping-pong.
        (repositoryIdentity != null &&
          JSON.stringify(binding.repositoryIdentity ?? null) !==
            JSON.stringify(repositoryIdentity)))
    ) {
      await ctx.db.patch(binding._id, {
        ...(localWorkspaceRoot === null ? {} : { localWorkspaceRoot }),
        ...(repositoryIdentity == null ? {} : { repositoryIdentity, repositoryKey }),
        status: localWorkspaceRoot === null ? "missing" : "active",
        lastSeenAt: now,
        updatedAt: now,
      });
      binding = await ctx.db.get(binding._id);
      if (binding === null) throw backendError("entity-not-found", "The project binding vanished.");
      bindingChanged = true;
    }

    if (projectChanged || bindingChanged) {
      await appendCompanyChanges(ctx, {
        companyId: actor.company._id,
        actor: actorRecord(actor),
        changes: [
          ...(projectChanged
            ? [
                {
                  entityKind: "cloudProject" as const,
                  entityId: project.id,
                  changeKind: "upsert" as const,
                  versionDocId: project._id,
                  payload: encodeCloudProject(project),
                },
              ]
            : []),
          ...(!bindingChanged || binding === null
            ? []
            : [
                {
                  entityKind: "environmentBinding" as const,
                  entityId: binding.id,
                  changeKind: "upsert" as const,
                  versionDocId: binding._id,
                  payload: await encodeEnvironmentBinding(ctx, binding),
                },
              ]),
        ],
      });
    }

    return project.id;
  },
});

/** Chooses the checkout future issue automation should use for this company project. */
export const setPreferredEnvironmentBinding = mutation({
  args: {
    companyId: domainIdArg,
    cloudProjectId: domainIdArg,
    bindingId: domainIdArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const project = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.cloudProjectId),
      )
      .unique();
    if (project === null || project.deletedAt !== null || project.archivedAt !== null) {
      throw backendError("entity-not-found", "The project is no longer available.");
    }
    const binding = await ctx.db
      .query("environmentBindings")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.bindingId),
      )
      .unique();
    if (
      binding === null ||
      binding.cloudProjectId !== project._id ||
      binding.status === "revoked"
    ) {
      throw backendError(
        "invalid-arguments",
        "The selected environment is not connected to this project.",
      );
    }
    if (project.preferredBindingId === binding.id) return null;

    const now = Date.now();
    await ctx.db.patch(project._id, { preferredBindingId: binding.id, updatedAt: now });
    const changedProject = await ctx.db.get(project._id);
    if (changedProject === null) throw backendError("entity-not-found", "The project vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "cloudProject",
          entityId: changedProject.id,
          changeKind: "upsert",
          versionDocId: changedProject._id,
          payload: encodeCloudProject(changedProject),
        },
      ],
    });
    return null;
  },
});

/** Revokes this machine's binding when its local project is removed. */
export const releaseEnvironmentProject = mutation({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    localProjectId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const environmentId = trimmed(args.environmentId, "An environment id");
    const localProjectId = trimmed(args.localProjectId, "A local project id");
    const binding = (
      await ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
        )
        .collect()
    ).find((row) => row.localProjectId === localProjectId && row.status !== "revoked");
    if (binding === undefined || binding.status === "revoked") return null;

    const now = Date.now();
    await ctx.db.patch(binding._id, { status: "revoked", lastSeenAt: now, updatedAt: now });
    const revoked = await ctx.db.get(binding._id);
    if (revoked === null) throw backendError("entity-not-found", "The project binding vanished.");

    const project = await ctx.db.get(binding.cloudProjectId);
    let changedProject = project;
    if (project !== null && project.preferredBindingId === binding.id) {
      const replacement = (
        await ctx.db
          .query("environmentBindings")
          .withIndex("by_company_and_project", (q) =>
            q.eq("companyId", actor.company._id).eq("cloudProjectId", project._id),
          )
          .collect()
      ).find((row) => row._id !== binding._id && row.status === "active");
      await ctx.db.patch(project._id, {
        preferredBindingId: replacement?.id ?? null,
        updatedAt: now,
      });
      changedProject = await ctx.db.get(project._id);
    }

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "environmentBinding",
          entityId: revoked.id,
          changeKind: "upsert",
          versionDocId: revoked._id,
          payload: await encodeEnvironmentBinding(ctx, revoked),
        },
        ...(changedProject === null || changedProject === project
          ? []
          : [
              {
                entityKind: "cloudProject" as const,
                entityId: changedProject.id,
                changeKind: "upsert" as const,
                versionDocId: changedProject._id,
                payload: encodeCloudProject(changedProject),
              },
            ]),
      ],
    });
    return null;
  },
});

/**
 * Marks bindings stale when their environment's registration is gone or revoked.
 *
 * A re-paired machine gets a new environment id, and nothing else retires the old bindings: the
 * publisher only releases on local project deletion. Left active, orphaned rows keep dead
 * checkouts eligible as work targets and keep ghost duplicates of the same repository alive in
 * every client. Stale, not revoked — revocation is the durable "this checkout was deleted" signal
 * environments consume, while staleness just means "this machine is no longer one of ours".
 */
export const revokeStaleEnvironmentBindings = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const candidates = (await ctx.db.query("environmentBindings").collect()).filter(
      (binding) => binding.status === "active" || binding.status === "missing",
    );
    const now = Date.now();
    const changesByCompany = new Map<Id<"companies">, CompanyChange[]>();
    for (const binding of candidates) {
      const registration = await ctx.db
        .query("environmentRegistrations")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", binding.companyId).eq("environmentId", binding.environmentId),
        )
        .unique();
      if (registration !== null && registration.state === "active") continue;

      await ctx.db.patch(binding._id, { status: "stale", lastSeenAt: now, updatedAt: now });
      const stale = await ctx.db.get(binding._id);
      if (stale === null) throw backendError("entity-not-found", "A project binding vanished.");
      const changes = changesByCompany.get(binding.companyId) ?? [];
      changes.push({
        entityKind: "environmentBinding",
        entityId: stale.id,
        changeKind: "upsert",
        versionDocId: stale._id,
        payload: await encodeEnvironmentBinding(ctx, stale),
      });

      const project = await ctx.db.get(stale.cloudProjectId);
      if (project !== null && project.preferredBindingId === stale.id) {
        const replacement = (
          await ctx.db
            .query("environmentBindings")
            .withIndex("by_company_and_project", (q) =>
              q.eq("companyId", binding.companyId).eq("cloudProjectId", project._id),
            )
            .collect()
        ).find((row) => row._id !== stale._id && row.status === "active");
        await ctx.db.patch(project._id, {
          preferredBindingId: replacement?.id ?? null,
          updatedAt: now,
        });
        const changedProject = await ctx.db.get(project._id);
        if (changedProject === null) {
          throw backendError("entity-not-found", "The project vanished.");
        }
        changes.push({
          entityKind: "cloudProject",
          entityId: changedProject.id,
          changeKind: "upsert",
          versionDocId: changedProject._id,
          payload: encodeCloudProject(changedProject),
        });
      }
      changesByCompany.set(binding.companyId, changes);
    }

    for (const [companyId, changes] of changesByCompany) {
      if (changes.length === 0) continue;
      await appendCompanyChanges(ctx, {
        companyId,
        actor: { kind: "system", source: "automation" },
        changes,
      });
    }
    return null;
  },
});

/**
 * Collapses two company projects into one durable identity.
 *
 * The target survives. Every checkout and project-owned record moves to it in the same Convex
 * transaction, while the selected repository becomes authoritative for every binding. Connected
 * environments consume that repository decision from the company feed and update their Git
 * remote; offline environments do the same when they reconnect.
 */
export const mergeCompanyProjects = mutation({
  args: {
    companyId: domainIdArg,
    sourceCloudProjectId: domainIdArg,
    targetCloudProjectId: domainIdArg,
    repositoryIdentity: repositoryIdentityArg,
  },
  returns: v.object({
    movedBindings: v.number(),
    movedThreads: v.number(),
    movedIssues: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.sourceCloudProjectId === args.targetCloudProjectId) {
      throw backendError("invalid-arguments", "Choose two different projects to merge.");
    }
    const actor = await requireCompanyActor(ctx, args.companyId);
    const source = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.sourceCloudProjectId),
      )
      .unique();
    const target = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.targetCloudProjectId),
      )
      .unique();
    if (
      source === null ||
      source.deletedAt !== null ||
      target === null ||
      target.deletedAt !== null
    ) {
      throw backendError("entity-not-found", "One of the projects is no longer available.");
    }
    requireRecordPermission(actor, "projects.manage", source.teamIds);
    requireRecordPermission(actor, "projects.manage", target.teamIds);

    const combinedTeamIds = mergedProjectTeamIds(source.teamIds, target.teamIds);
    const replayTargetScope = projectTeamScopeWidened(target.teamIds, combinedTeamIds);
    const projectRowLimit = PROJECT_MERGE_MAX_AFFECTED_ROWS + 1;
    const companyScanLimit = PROJECT_MERGE_MAX_COMPANY_SCAN_ROWS + 1;

    const [
      sourceBindings,
      targetBindings,
      sourceThreads,
      targetThreads,
      sourceMilestones,
      targetMilestones,
      sourceEmails,
      targetEmails,
      commands,
      sourceIssues,
      automationJobs,
      slackWatches,
      slackIntents,
    ] = await Promise.all([
      ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", source._id),
        )
        .take(projectRowLimit),
      ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", target._id),
        )
        .take(projectRowLimit),
      ctx.db
        .query("agentThreads")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", source._id),
        )
        .take(projectRowLimit),
      replayTargetScope
        ? ctx.db
            .query("agentThreads")
            .withIndex("by_company_and_project", (q) =>
              q.eq("companyId", actor.company._id).eq("cloudProjectId", target._id),
            )
            .take(projectRowLimit)
        : Promise.resolve([]),
      ctx.db
        .query("issueMilestones")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", source.id),
        )
        .take(projectRowLimit),
      replayTargetScope
        ? ctx.db
            .query("issueMilestones")
            .withIndex("by_company_and_project", (q) =>
              q.eq("companyId", actor.company._id).eq("cloudProjectId", target.id),
            )
            .take(projectRowLimit)
        : Promise.resolve([]),
      ctx.db
        .query("capturedEmails")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", source._id),
        )
        .take(PROJECT_MERGE_MAX_CAPTURED_EMAIL_ROWS + 1),
      replayTargetScope
        ? ctx.db
            .query("capturedEmails")
            .withIndex("by_company_and_project", (q) =>
              q.eq("companyId", actor.company._id).eq("cloudProjectId", target._id),
            )
            .take(PROJECT_MERGE_MAX_CAPTURED_EMAIL_ROWS + 1)
        : Promise.resolve([]),
      collectActiveProjectCommands(ctx, actor.company._id, source._id),
      ctx.db
        .query("issues")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("projectId", source.id),
        )
        .take(projectRowLimit),
      ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", source._id),
        )
        .take(projectRowLimit),
      ctx.db
        .query("slackChannelWatches")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .take(companyScanLimit),
      ctx.db
        .query("slackIssueAutomationIntents")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", source._id),
        )
        .take(projectRowLimit),
    ]);

    for (const [label, rows] of [
      ["source bindings", sourceBindings],
      ["target bindings", targetBindings],
      ["source threads", sourceThreads],
      ["target threads", targetThreads],
      ["source milestones", sourceMilestones],
      ["target milestones", targetMilestones],
      ["source issues", sourceIssues],
      ["automation jobs", automationJobs],
      ["Slack automation intents", slackIntents],
    ] as const) {
      assertBoundedProjectMergeRows(label, rows.length, PROJECT_MERGE_MAX_AFFECTED_ROWS);
    }
    assertBoundedProjectMergeRows(
      "source captured emails",
      sourceEmails.length,
      PROJECT_MERGE_MAX_CAPTURED_EMAIL_ROWS,
    );
    assertBoundedProjectMergeRows(
      "target captured emails",
      targetEmails.length,
      PROJECT_MERGE_MAX_CAPTURED_EMAIL_ROWS,
    );
    assertBoundedProjectMergeRows(
      "environment commands",
      commands.length,
      PROJECT_MERGE_MAX_COMMAND_ROWS,
    );
    assertBoundedProjectMergeRows(
      "Slack watches",
      slackWatches.length,
      PROJECT_MERGE_MAX_COMPANY_SCAN_ROWS,
    );

    const targetEnvironmentIds = new Set(
      targetBindings
        .filter((binding) => binding.status !== "revoked")
        .map((binding) => binding.environmentId),
    );
    const duplicateConnection = sourceBindings.find(
      (binding) => binding.status !== "revoked" && targetEnvironmentIds.has(binding.environmentId),
    );
    if (duplicateConnection !== undefined) {
      throw backendError(
        "foreign-id-conflict",
        "The projects both have active connections in one environment. Remove one connection before merging.",
      );
    }
    const storedRepositoryIdentities = [
      source.repositoryIdentity,
      target.repositoryIdentity,
      ...sourceBindings.map((binding) => binding.repositoryIdentity),
      ...targetBindings.map((binding) => binding.repositoryIdentity),
    ].filter((identity): identity is StoredRepositoryIdentity => identity != null);
    const selectedRepositoryIdentity = storedRepositoryIdentities.find((identity) =>
      sameRepositoryIdentity(identity, args.repositoryIdentity),
    );
    if (selectedRepositoryIdentity === undefined) {
      throw backendError(
        "invalid-arguments",
        "Choose a Git repository already detected on one of these projects.",
      );
    }

    const { rootPath: _selectedRootPath, ...authoritativeRepositoryIdentity } =
      selectedRepositoryIdentity;
    const sourceCommands = commands;
    const sourceAutomationJobs = automationJobs;
    const sourceSlackIntents = slackIntents;
    const affectedSlackWatches = slackWatches.flatMap((watch) => {
      const direct = watch.cloudProjectId === source._id;
      const trigger = replaceProjectReactionRoutes(watch.trigger, source.id, target.id);
      const rules = replaceProjectRoutingRules(watch.rules, source.id, target.id);
      return direct || trigger !== watch.trigger || rules !== watch.rules
        ? [{ watch, direct, trigger, rules }]
        : [];
    });
    const affectedRowCount =
      [...targetBindings, ...sourceBindings].filter((binding) => binding.status !== "revoked")
        .length +
      sourceThreads.length +
      targetThreads.length +
      sourceMilestones.length +
      targetMilestones.length +
      sourceEmails.length +
      targetEmails.length +
      sourceIssues.length +
      sourceCommands.length +
      sourceAutomationJobs.length +
      sourceSlackIntents.length +
      affectedSlackWatches.length +
      2;
    assertBoundedProjectMergeRows(
      "project records",
      affectedRowCount,
      PROJECT_MERGE_MAX_AFFECTED_ROWS,
    );
    assertBoundedProjectMergeBytes([
      source,
      target,
      ...sourceBindings,
      ...targetBindings,
      ...sourceThreads,
      ...targetThreads,
      ...sourceMilestones,
      ...targetMilestones,
      ...sourceEmails,
      ...targetEmails,
      ...sourceIssues,
      ...sourceCommands,
      ...sourceAutomationJobs,
      ...sourceSlackIntents,
      ...affectedSlackWatches,
    ]);
    const now = Date.now();
    const changes: CompanyChange[] = [];
    const updatedBindings: Doc<"environmentBindings">[] = [];
    for (const binding of [...targetBindings, ...sourceBindings]) {
      if (binding.status === "revoked") continue;
      await ctx.db.patch(binding._id, {
        cloudProjectId: target._id,
        repositoryIdentity: {
          ...authoritativeRepositoryIdentity,
          rootPath: binding.localWorkspaceRoot,
        },
        repositoryKey: authoritativeRepositoryIdentity.canonicalKey,
        updatedAt: now,
      });
      const updated = await ctx.db.get(binding._id);
      if (updated === null) throw backendError("entity-not-found", "A project binding vanished.");
      updatedBindings.push(updated);
      changes.push({
        entityKind: "environmentBinding",
        entityId: updated.id,
        changeKind: "upsert",
        versionDocId: updated._id,
        payload: await encodeEnvironmentBinding(ctx, updated),
      });
    }

    for (const thread of sourceThreads) {
      await ctx.db.patch(thread._id, { cloudProjectId: target._id, updatedAt: now });
      const updated = await ctx.db.get(thread._id);
      if (updated === null) throw backendError("entity-not-found", "An agent thread vanished.");
      changes.push({
        entityKind: "agentThread",
        entityId: updated.id,
        changeKind: "upsert",
        teamIds: combinedTeamIds,
        versionDocId: updated._id,
        payload: await encodeAgentThread(ctx, updated),
      });
    }
    for (const email of sourceEmails) {
      await ctx.db.patch(email._id, { cloudProjectId: target._id, updatedAt: now });
      const updated = await ctx.db.get(email._id);
      if (updated === null) throw backendError("entity-not-found", "A captured email vanished.");
      changes.push({
        entityKind: "capturedEmail",
        entityId: updated.id,
        changeKind: "upsert",
        teamIds: combinedTeamIds,
        versionDocId: updated._id,
        payload: await encodeCapturedEmail(ctx, updated),
      });
    }
    for (const milestone of sourceMilestones) {
      await ctx.db.patch(milestone._id, { cloudProjectId: target.id, updatedAt: now });
      const updated = await ctx.db.get(milestone._id);
      if (updated === null) throw backendError("entity-not-found", "A milestone vanished.");
      if (updated.deletedAt === null) {
        changes.push({
          entityKind: "issueMilestone",
          entityId: updated.id,
          changeKind: "upsert",
          teamIds: combinedTeamIds,
          versionDocId: updated._id,
          payload: encodeIssueMilestone(actor.company, updated),
        });
      }
    }
    for (const issue of sourceIssues) {
      await ctx.db.patch(issue._id, { projectId: target.id, updatedAt: now });
      const updated = await ctx.db.get(issue._id);
      if (updated === null) throw backendError("entity-not-found", "An issue vanished.");
      if (updated.deletedAt === null) {
        changes.push({
          entityKind: "issue",
          entityId: updated.id,
          changeKind: "upsert",
          teamIds: updated.teamIds,
          versionDocId: updated._id,
          payload: encodeIssue(actor.company, updated),
        });
      }
    }

    // A widened target scope has new readers. Replay its existing project-owned rows so those
    // readers receive a complete snapshot rather than only the records moved from the source.
    for (const thread of targetThreads) {
      changes.push({
        entityKind: "agentThread",
        entityId: thread.id,
        changeKind: "upsert",
        teamIds: combinedTeamIds,
        versionDocId: thread._id,
        payload: await encodeAgentThread(ctx, thread),
      });
    }
    for (const email of targetEmails) {
      changes.push({
        entityKind: "capturedEmail",
        entityId: email.id,
        changeKind: "upsert",
        teamIds: combinedTeamIds,
        versionDocId: email._id,
        payload: await encodeCapturedEmail(ctx, email),
      });
    }
    for (const milestone of targetMilestones) {
      if (milestone.deletedAt !== null) continue;
      changes.push({
        entityKind: "issueMilestone",
        entityId: milestone.id,
        changeKind: "upsert",
        teamIds: combinedTeamIds,
        versionDocId: milestone._id,
        payload: encodeIssueMilestone(actor.company, milestone),
      });
    }

    for (const command of sourceCommands) {
      const wasClaimed = command.state === "claimed";
      await ctx.db.patch(command._id, {
        cloudProjectId: target._id,
        ...(wasClaimed
          ? {
              state: "pending" as const,
              bindingId: null,
              claimedByEnvironmentId: null,
              claimGeneration: command.claimGeneration + 1,
              claimExpiresAt: null,
            }
          : {}),
        updatedAt: now,
      });
      const updated = await ctx.db.get(command._id);
      if (updated === null) throw backendError("entity-not-found", "A command vanished.");
      changes.push({
        entityKind: "environmentCommand",
        entityId: updated.id,
        changeKind: "upsert",
        versionDocId: updated._id,
        payload: await encodeEnvironmentCommand(ctx, updated),
      });
    }
    for (const job of sourceAutomationJobs) {
      await ctx.db.patch(job._id, { cloudProjectId: target._id, updatedAt: now });
    }
    for (const intent of sourceSlackIntents) {
      await ctx.db.patch(intent._id, { cloudProjectId: target._id, updatedAt: now });
    }
    for (const { watch, direct, trigger, rules } of affectedSlackWatches) {
      await ctx.db.patch(watch._id, {
        ...(direct ? { cloudProjectId: target._id } : {}),
        ...(trigger === watch.trigger ? {} : { trigger }),
        ...(rules === watch.rules ? {} : { rules }),
        revision: watch.revision + 1,
        updatedAt: now,
      });
    }
    const preferredBindingId =
      target.preferredBindingId ??
      (source.preferredBindingId !== null &&
      updatedBindings.some((binding) => binding.id === source.preferredBindingId)
        ? source.preferredBindingId
        : (updatedBindings.find((binding) => binding.status === "active")?.id ?? null));
    await ctx.db.patch(target._id, {
      teamIds: combinedTeamIds,
      preferredBindingId,
      repositoryIdentity: authoritativeRepositoryIdentity,
      repositoryIdentityAuthority: "merge",
      updatedAt: now,
    });
    const updatedTarget = await ctx.db.get(target._id);
    if (updatedTarget === null)
      throw backendError("entity-not-found", "The target project vanished.");
    changes.push({
      entityKind: "cloudProject",
      entityId: updatedTarget.id,
      changeKind: "upsert",
      teamIds: combinedTeamIds,
      versionDocId: updatedTarget._id,
      payload: encodeCloudProject(updatedTarget),
    });

    await ctx.db.patch(source._id, { preferredBindingId: null, deletedAt: now, updatedAt: now });
    changes.push({
      entityKind: "cloudProject",
      entityId: source.id,
      changeKind: "tombstone",
      teamIds: source.teamIds,
      versionDocId: source._id,
      payload: null,
    });

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes,
    });
    await ctx.scheduler.runAfter(0, internal.cloudProjects.retargetMergedProjectIssueViews, {
      companyId: actor.company._id,
      sourceProjectId: source.id,
      targetProjectId: target.id,
      cursor: null,
    });
    return {
      movedBindings: sourceBindings.filter((binding) => binding.status !== "revoked").length,
      movedThreads: sourceThreads.length,
      movedIssues: sourceIssues.filter((issue) => issue.deletedAt === null).length,
    };
  },
});

/**
 * Deletes the company-owned project without requiring any of its checkout environments online.
 *
 * Bindings remain as revoked feed rows until their environments consume them. That durable intent
 * is what lets an offline server remove its local project and threads when it reconnects, while
 * the project tombstone removes the shared identity from every company client immediately.
 *
 * `deleted` reports whether this call removed anything. A caller that owns the same project id in
 * several companies asks each of them in turn, and most of those asks legitimately match nothing;
 * without this flag a run where *every* ask matched nothing is indistinguishable from a successful
 * delete, so the UI navigates away from a project it never removed.
 */
export const deleteCompanyProject = mutation({
  args: {
    companyId: domainIdArg,
    cloudProjectId: domainIdArg,
  },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const project = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.cloudProjectId),
      )
      .unique();
    if (project === null || project.deletedAt !== null) return { deleted: false };
    requireRecordPermission(actor, "projects.manage", project.teamIds);

    const [
      bindings,
      agentThreads,
      milestones,
      capturedEmails,
      environmentCommands,
      slackWatches,
      slackIntegrations,
      issueData,
    ] = await Promise.all([
      ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", project._id),
        )
        .collect(),
      ctx.db
        .query("agentThreads")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", project._id),
        )
        .collect(),
      ctx.db
        .query("issueMilestones")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", project.id),
        )
        .collect(),
      ctx.db
        .query("capturedEmails")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", actor.company._id).eq("cloudProjectId", project._id),
        )
        .collect(),
      ctx.db
        .query("environmentCommands")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect()
        .then((rows) => rows.filter((row) => row.cloudProjectId === project._id)),
      ctx.db
        .query("slackChannelWatches")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect(),
      ctx.db
        .query("slackIntegrations")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect(),
      collectProjectIssueData(ctx, actor.company._id, project.id),
    ]);
    const issueIds = new Set(issueData.issues.map((issue) => issue.id));
    const [automationJobs, slackAutomationIntents] = await Promise.all([
      ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect()
        .then((rows) =>
          rows.filter((row) => row.cloudProjectId === project._id || issueIds.has(row.issueId)),
        ),
      ctx.db
        .query("slackIssueAutomationIntents")
        .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
        .collect()
        .then((rows) =>
          rows.filter((row) => row.cloudProjectId === project._id || issueIds.has(row.issueId)),
        ),
    ]);
    const slackProcessedMessages: Doc<"slackProcessedMessages">[] = [];
    for (const issueId of issueIds) {
      slackProcessedMessages.push(
        ...(await ctx.db
          .query("slackProcessedMessages")
          .withIndex("by_issue", (q) => q.eq("companyId", actor.company._id).eq("issueId", issueId))
          .collect()),
      );
    }
    const slackOutboundDeliveries: Doc<"slackOutboundDeliveries">[] = [];
    for (const integration of slackIntegrations) {
      slackOutboundDeliveries.push(
        ...(await ctx.db
          .query("slackOutboundDeliveries")
          .withIndex("by_integration", (q) => q.eq("integrationId", integration._id))
          .collect()
          .then((rows) =>
            rows.filter((row) => row.issueId !== undefined && issueIds.has(row.issueId)),
          )),
      );
    }

    const now = Date.now();
    const changes: CompanyChange[] = [];
    await deleteProjectFocusAssignments(ctx, bindings);
    for (const binding of bindings) {
      if (binding.status === "revoked") continue;
      await ctx.db.patch(binding._id, {
        status: "revoked",
        lastSeenAt: now,
        updatedAt: now,
      });
      const revoked = await ctx.db.get(binding._id);
      if (revoked === null) throw backendError("entity-not-found", "A project binding vanished.");
      changes.push({
        entityKind: "environmentBinding" as const,
        entityId: revoked.id,
        changeKind: "upsert" as const,
        versionDocId: revoked._id,
        payload: await encodeEnvironmentBinding(ctx, revoked),
      });
    }

    // A project command has no useful target once the project is gone. Its tombstone also fences
    // any in-flight claimant when it tries to report completion.
    for (const command of environmentCommands) {
      await ctx.db.delete(command._id);
      changes.push({
        entityKind: "environmentCommand",
        entityId: command.id,
        changeKind: "tombstone",
        versionDocId: null,
        payload: null,
      });
    }

    // Captured mail is environment-owned at the byte level. The durable deletion marker is what
    // tells an offline source to remove its raw message and attachments instead of republishing it.
    for (const email of capturedEmails) {
      const deletion = await ctx.db
        .query("capturedEmailDeletions")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", email.id),
        )
        .unique();
      if (deletion === null) {
        await ctx.db.insert("capturedEmailDeletions", {
          id: email.id,
          companyId: actor.company._id,
          environmentId: email.environmentId,
          messageId: email.messageId,
          deletedAt: now,
        });
      }
      await ctx.db.delete(email._id);
      changes.push({
        entityKind: "capturedEmail",
        entityId: email.id,
        changeKind: "tombstone",
        teamIds: project.teamIds,
        versionDocId: null,
        payload: null,
      });
    }

    // Thread shells are shared discovery metadata only. Their owning environment will delete the
    // full local threads when it consumes the revoked binding.
    for (const thread of agentThreads) {
      await ctx.db.delete(thread._id);
      changes.push({
        entityKind: "agentThread" as const,
        entityId: thread.id,
        changeKind: "tombstone" as const,
        teamIds: project.teamIds,
        versionDocId: null,
        payload: null,
      });
    }

    const issueById = new Map(issueData.issues.map((issue) => [issue.id, issue] as const));
    const issueTeams = (issueId: string): readonly string[] =>
      issueById.get(issueId)?.teamIds ?? [];
    const removeIssueRow = async (
      entityKind:
        | "issueTodo"
        | "issueComment"
        | "issueAttachment"
        | "issueAuditEvent"
        | "issueThreadLink"
        | "issueRelation",
      row: {
        readonly _id: Id<
          | "issueTodos"
          | "issueComments"
          | "issueAttachments"
          | "issueAuditEvents"
          | "issueThreadLinks"
          | "issueRelations"
        >;
        readonly id: string;
        readonly issueId: string;
      },
      teamIds: readonly string[] = issueTeams(row.issueId),
    ) => {
      await ctx.db.delete(row._id);
      changes.push({
        entityKind,
        entityId: row.id,
        changeKind: "tombstone",
        teamIds,
        versionDocId: null,
        payload: null,
      });
    };

    for (const child of issueData.childrenToDetach) {
      await ctx.db.patch(child._id, { parentId: null, updatedAt: now });
      const updated = await ctx.db.get(child._id);
      if (updated === null) throw backendError("entity-not-found", "A child issue vanished.");
      changes.push({
        entityKind: "issue",
        entityId: updated.id,
        changeKind: "upsert",
        teamIds: updated.teamIds,
        versionDocId: updated._id,
        payload: encodeIssue(actor.company, updated),
      });
    }

    for (const row of issueData.todos) await removeIssueRow("issueTodo", row);
    for (const row of issueData.comments) await removeIssueRow("issueComment", row);
    const attachmentTargets: Array<{
      docId: Id<"issueAttachments">;
      key: string | null;
    }> = [];
    for (const row of issueData.attachments) {
      if (row.storageId !== null) await ctx.storage.delete(row.storageId);
      attachmentTargets.push({ docId: row._id, key: row.uploadthingFileKey ?? null });
      await removeIssueRow("issueAttachment", row);
    }
    for (const row of issueData.auditEvents) await removeIssueRow("issueAuditEvent", row);
    for (const row of issueData.threadLinks) await removeIssueRow("issueThreadLink", row);
    for (const row of issueData.relations) {
      const relatedTeams = issueTeams(row.relatedIssueId);
      await removeIssueRow("issueRelation", row, [
        ...new Set([...issueTeams(row.issueId), ...relatedTeams]),
      ]);
    }
    for (const issue of issueData.issues) {
      await ctx.db.delete(issue._id);
      changes.push({
        entityKind: "issue",
        entityId: issue.id,
        changeKind: "tombstone",
        teamIds: issue.teamIds,
        versionDocId: null,
        payload: null,
      });
    }
    if (attachmentTargets.length > 0) {
      await ctx.scheduler.runAfter(0, internal.issueAttachments.deleteUploadThingFiles, {
        targets: attachmentTargets,
      });
    }

    // Automation and Slack delivery rows are execution state, not history worth retaining after
    // their target issue is gone. The processed-message ledger remains only as a dedupe marker.
    for (const job of automationJobs) await ctx.db.delete(job._id);
    for (const intent of slackAutomationIntents) await ctx.db.delete(intent._id);
    for (const delivery of slackOutboundDeliveries) await ctx.db.delete(delivery._id);
    for (const processed of slackProcessedMessages) {
      await ctx.db.patch(processed._id, {
        disposition: "ignored",
        issueId: null,
        commentId: null,
        reason: "Project deleted.",
        processedAt: now,
      });
    }

    // A watch may contain several independent routes. Sever only the routes for this project,
    // invalidate pending decisions made from the old revision, and leave unrelated routes intact.
    const changedIntegrations = new Map<Id<"slackIntegrations">, number>();
    for (const watch of slackWatches) {
      const direct = watch.cloudProjectId === project._id;
      const trigger = withoutProjectReactionRoutes(watch.trigger, project.id, direct);
      const rules = withoutProjectRoutingRules(watch.rules, project.id);
      if (!direct && !trigger.changed && !rules.changed) continue;
      const deleteWatch = !hasSlackRoutes(watch.configurationVersion, trigger.trigger, rules.rules);
      changedIntegrations.set(
        watch.integrationId,
        (changedIntegrations.get(watch.integrationId) ?? 0) + (deleteWatch ? 1 : 0),
      );
      const pending = await ctx.db
        .query("slackPendingIntake")
        .withIndex("by_integration_channel_and_message", (q) =>
          q.eq("integrationId", watch.integrationId).eq("channelId", watch.channelId),
        )
        .collect();
      for (const row of pending) await ctx.db.delete(row._id);
      if (deleteWatch) {
        await ctx.db.delete(watch._id);
        const cursor = await ctx.db
          .query("slackChannelCursors")
          .withIndex("by_integration_and_channel", (q) =>
            q.eq("integrationId", watch.integrationId).eq("channelId", watch.channelId),
          )
          .unique();
        if (cursor !== null) await ctx.db.delete(cursor._id);
      } else {
        await ctx.db.patch(watch._id, {
          ...(direct ? { cloudProjectId: null, cycleId: null } : {}),
          ...(trigger.changed ? { trigger: trigger.trigger } : {}),
          ...(rules.changed ? { rules: rules.rules } : {}),
          revision: watch.revision + 1,
          updatedAt: now,
        });
      }
    }
    for (const [integrationId, removedWatches] of changedIntegrations) {
      const integration = await ctx.db.get(integrationId);
      if (integration === null) continue;
      await ctx.db.patch(integration._id, {
        watchCount: Math.max(0, integration.watchCount - removedWatches),
        configurationRevision: integration.configurationRevision + 1,
        updatedAt: now,
      });
    }

    // Milestones cannot exist without their project. Existing issues already tolerate an unknown
    // milestone or project as "none", matching the ordinary issue-milestone delete semantics.
    for (const milestone of milestones) {
      if (milestone.deletedAt !== null) continue;
      await ctx.db.patch(milestone._id, { deletedAt: now, updatedAt: now });
      changes.push({
        entityKind: "issueMilestone" as const,
        entityId: milestone.id,
        changeKind: "tombstone" as const,
        teamIds: project.teamIds,
        versionDocId: milestone._id,
        payload: null,
      });
    }

    await ctx.db.patch(project._id, {
      preferredBindingId: null,
      deletedAt: now,
      updatedAt: now,
    });
    changes.push({
      entityKind: "cloudProject" as const,
      entityId: project.id,
      changeKind: "tombstone" as const,
      teamIds: project.teamIds,
      versionDocId: project._id,
      payload: null,
    });

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes,
    });
    return { deleted: true };
  },
});
