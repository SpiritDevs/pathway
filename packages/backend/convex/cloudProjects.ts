// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Online administration for company-owned projects and their environment-local bindings. */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel.js";
import { mutation } from "./_generated/server.js";
import {
  appendCompanyChanges,
  encodeCloudProject,
  encodeEnvironmentBinding,
} from "./lib/companyApply.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import { actorRecord, requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

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
 */
export const ensureEnvironmentProject = mutation({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    localProjectId: v.string(),
    localWorkspaceRoot: v.union(v.string(), v.null()),
    name: v.string(),
  },
  returns: domainIdArg,
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

    let project = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", localProjectId),
      )
      .unique();
    const now = Date.now();
    let projectChanged = false;
    if (project === null) {
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
    } else if (project.name !== name || project.archivedAt !== null || project.deletedAt !== null) {
      await ctx.db.patch(project._id, {
        name,
        archivedAt: null,
        deletedAt: null,
        updatedAt: now,
      });
      project = await ctx.db.get(project._id);
      if (project === null) throw backendError("entity-not-found", "The project vanished.");
      projectChanged = true;
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
        binding.status !== (localWorkspaceRoot === null ? "missing" : "active"))
    ) {
      await ctx.db.patch(binding._id, {
        ...(localWorkspaceRoot === null ? {} : { localWorkspaceRoot }),
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
