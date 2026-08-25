// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Online administration for company-owned projects and their environment-local bindings. */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, internalMutation } from "./_generated/server.js";
import {
  appendCompanyChanges,
  encodeCloudProject,
  encodeEnvironmentBinding,
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
import { domainIdArg, repositoryIdentityArg } from "./lib/validators.ts";

function trimmed(value: string, label: string): string {
  const result = value.trim();
  if (result.length === 0) throw backendError("invalid-arguments", `${label} is required.`);
  return result;
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
        ).find((row) => row.localProjectId === localProjectId) ?? null);
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
    } else if (project.name !== name || project.archivedAt !== null) {
      await ctx.db.patch(project._id, {
        name,
        archivedAt: null,
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
        (repositoryIdentity !== undefined &&
          JSON.stringify(binding.repositoryIdentity ?? null) !==
            JSON.stringify(repositoryIdentity)))
    ) {
      await ctx.db.patch(binding._id, {
        ...(localWorkspaceRoot === null ? {} : { localWorkspaceRoot }),
        ...(repositoryIdentity === undefined ? {} : { repositoryIdentity, repositoryKey }),
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
    ).find((row) => row.localProjectId === localProjectId);
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

    const [bindings, agentThreads, milestones] = await Promise.all([
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
    ]);

    const now = Date.now();
    const changes = [];
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
