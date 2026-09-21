import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";

type Registration = Doc<"environmentRegistrations">;
type Presence = Pick<Registration, "lastSeenAt" | "orchestratorPresence">;
type Runtime = Pick<
  Registration,
  | "orchestratorResources"
  | "orchestratorDelegationCatalog"
  | "orchestratorDelegationCatalogAt"
  | "agentThreadReconciliation"
  | "capturedEmailReconciliation"
>;
type RuntimePatch = { [K in keyof Runtime]?: Runtime[K] | undefined };
const runtimeFields = (row: RuntimePatch): Runtime => ({
  ...(row.orchestratorResources === undefined
    ? {}
    : { orchestratorResources: row.orchestratorResources }),
  ...(row.orchestratorDelegationCatalog === undefined
    ? {}
    : { orchestratorDelegationCatalog: row.orchestratorDelegationCatalog }),
  ...(row.orchestratorDelegationCatalogAt === undefined
    ? {}
    : { orchestratorDelegationCatalogAt: row.orchestratorDelegationCatalogAt }),
  ...(row.agentThreadReconciliation === undefined
    ? {}
    : { agentThreadReconciliation: row.agentThreadReconciliation }),
  ...(row.capturedEmailReconciliation === undefined
    ? {}
    : { capturedEmailReconciliation: row.capturedEmailReconciliation }),
});
const presenceFields = (row: Presence): Presence => ({
  lastSeenAt: row.lastSeenAt,
  ...(row.orchestratorPresence === undefined
    ? {}
    : { orchestratorPresence: row.orchestratorPresence }),
});

/** Only freshness consumers opt in. Authorization must continue reading the registration alone. */
export async function readEnvironmentPresence(
  ctx: QueryCtx,
  registration: Registration,
): Promise<Presence> {
  const row = await ctx.db
    .query("environmentPresence")
    .withIndex("by_registration", (q) => q.eq("registrationId", registration._id))
    .unique();
  return presenceFields(row ?? registration);
}
export async function readEnvironmentRuntime(
  ctx: QueryCtx,
  registration: Registration,
): Promise<Runtime> {
  const row = await ctx.db
    .query("environmentRuntime")
    .withIndex("by_registration", (q) => q.eq("registrationId", registration._id))
    .unique();
  return runtimeFields(row ?? registration);
}

/** The first write copies legacy state atomically. Existing API callers need no migration flag. */
export async function patchEnvironmentPresence(
  ctx: MutationCtx,
  registration: Registration,
  patch: Partial<Presence>,
) {
  const row = await ctx.db
    .query("environmentPresence")
    .withIndex("by_registration", (q) => q.eq("registrationId", registration._id))
    .unique();
  if (row) await ctx.db.patch(row._id, patch);
  else {
    await ctx.db.insert("environmentPresence", {
      companyId: registration.companyId,
      registrationId: registration._id,
      ...presenceFields(registration),
      ...patch,
    });
    await ctx.db.patch(registration._id, { lastSeenAt: null, orchestratorPresence: undefined });
  }
}
export async function patchEnvironmentRuntime(
  ctx: MutationCtx,
  registration: Registration,
  patch: RuntimePatch,
) {
  const row = await ctx.db
    .query("environmentRuntime")
    .withIndex("by_registration", (q) => q.eq("registrationId", registration._id))
    .unique();
  if (row) await ctx.db.patch(row._id, patch);
  else {
    await ctx.db.insert("environmentRuntime", {
      companyId: registration.companyId,
      registrationId: registration._id,
      ...runtimeFields({ ...runtimeFields(registration), ...patch }),
    });
    await ctx.db.patch(registration._id, {
      orchestratorResources: undefined,
      orchestratorDelegationCatalog: undefined,
      orchestratorDelegationCatalogAt: undefined,
      agentThreadReconciliation: undefined,
      capturedEmailReconciliation: undefined,
    });
  }
}

/** Registration deletion is currently restricted to synthetic smoke data. */
export async function deleteEnvironmentRuntime(ctx: MutationCtx, registration: Registration) {
  for (const table of ["environmentPresence", "environmentRuntime"] as const) {
    const row = await ctx.db
      .query(table)
      .withIndex("by_registration", (q) => q.eq("registrationId", registration._id))
      .unique();
    if (row) await ctx.db.delete(row._id);
  }
}
