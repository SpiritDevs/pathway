// @effect-diagnostics globalDate:off -- Convex transaction clock and action verification timestamps.
/** Apple accounts, team credentials, concurrent environment leases, and project app links. */
import { v, ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import * as Schema from "effect/Schema";
import { AppleError, type AppleFailure } from "@spiritdevs/contracts/apple";
import { AppStoreConnectClient, AscCredential } from "../src/appStoreConnectApi.ts";
import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  integrationCredentialKeyringFromEnv,
} from "../src/integrationCredentials.ts";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  requireCompanyActor,
  requirePermission,
  requireRecordPermission,
  requireUser,
} from "./lib/identity.ts";
import { authorizeAppleAccount, authorizeAppleTeam } from "./lib/appleIdentity.ts";
import { backendError } from "./lib/errors.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { domainIdArg } from "./lib/validators.ts";
import {
  appleAccount,
  appleScope,
  appleTeam,
  appleTeamType,
  appleFailure,
  appleHealth,
  appleIntegration,
  appleApp,
  appleProjectLink,
  sealedAppleCredential,
} from "./lib/appleValidators.ts";

const isAppleError = Schema.is(AppleError);
const decodeCredential = Schema.decodeUnknownSync(Schema.fromJsonString(AscCredential));
const accountArgs = { accountId: v.string() };
const teamArgs = { ...accountArgs, teamId: v.string() };
const runtimeArgs = { ...teamArgs, companyId: domainIdArg };
const revisionArgs = { ...runtimeArgs, revision: v.number(), accountRevision: v.number() };
type TeamTarget = { accountId: string; teamId: string };
type RuntimeTarget = TeamTarget & { companyId: string };
type LeaseTarget = RuntimeTarget & { revision: number; accountRevision: number };
type Scope = { kind: "user" } | { kind: "company"; companyId: string };
type Metadata = {
  accountId: string;
  teamId: string;
  accountRevision: number;
  connected: boolean;
  revision: number;
  issuerId: string | null;
  keyIdSuffix: string | null;
  lastVerifiedAt: number | null;
};
function metadata(account: Doc<"appleAccounts">, team: Doc<"appleTeams">): Metadata {
  return {
    accountId: account.id,
    teamId: team.teamId,
    accountRevision: account.revision,
    connected: team.connected,
    revision: team.revision,
    issuerId: team.issuerId,
    keyIdSuffix: team.keyIdSuffix,
    lastVerifiedAt: team.lastVerifiedAt,
  };
}
async function presentAccount(ctx: QueryCtx, account: Doc<"appleAccounts">) {
  const company = account.companyId === null ? null : await ctx.db.get(account.companyId);
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    scope: company
      ? { kind: "company" as const, companyId: company.id }
      : { kind: "user" as const },
    revision: account.revision,
    createdAt: account.createdAt,
    verifiedAt: account.verifiedAt,
  };
}
const presentTeam = (accountId: string, team: Doc<"appleTeams">) => ({
  accountId,
  teamId: team.teamId,
  name: team.name,
  type: team.type,
});
function bounded(value: string, max: number) {
  if (!value.trim() || value.length > max)
    throw backendError("invalid-arguments", "An Apple account field is missing or too long.");
  return value.trim();
}
function assertRevision(actual: number, expected: number) {
  if (actual !== expected)
    throw backendError(
      "entity-conflict",
      "The Apple connection changed. Refresh before trying again.",
    );
}
async function scopeCompany(ctx: QueryCtx, scope: Scope) {
  if (scope.kind === "user") return null;
  const actor = await requireCompanyActor(ctx, scope.companyId);
  requirePermission(actor, "integrations.manage");
  if (actor.kind !== "member")
    throw backendError("permission-denied", "A company member must manage Apple accounts.");
  return actor.company._id;
}
const aad = (accountId: string, teamId: string, issuerId: string) => ({
  companyId: `apple-account:${accountId}`,
  integrationId: `asc-team:${teamId}`,
  workspaceId: issuerId,
});

export const listAccounts = query({
  args: { companyId: v.optional(domainIdArg) },
  returns: v.array(appleAccount),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const personal = (
      await ctx.db
        .query("appleAccounts")
        .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
        .collect()
    ).filter((a) => a.companyId === null);
    if (!args.companyId) return await Promise.all(personal.map((a) => presentAccount(ctx, a)));
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "integrations.read");
    const company = await ctx.db
      .query("appleAccounts")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    return await Promise.all([...personal, ...company].map((a) => presentAccount(ctx, a)));
  },
});
export const createAccount = mutation({
  args: { email: v.string(), displayName: v.string(), scope: v.optional(appleScope) },
  returns: appleAccount,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const companyId = await scopeCompany(ctx, args.scope ?? { kind: "user" });
    const email = bounded(args.email, 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
      throw backendError("invalid-arguments", "Enter a valid Apple ID email address.");
    const existing = await ctx.db
      .query("appleAccounts")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect();
    if (existing.some((a) => a.email === email && a.companyId === companyId))
      throw backendError("entity-conflict", "This Apple ID already exists in this scope.");
    const id = await ctx.db.insert("appleAccounts", {
      id: mintDomainId(Date.now()),
      ownerUserId: user._id,
      companyId,
      email,
      displayName: bounded(args.displayName, 200),
      revision: 1,
      createdAt: Date.now(),
      verifiedAt: null,
    });
    const account = await ctx.db.get(id);
    if (!account) throw new Error("Apple account disappeared.");
    return await presentAccount(ctx, account);
  },
});
export const updateAccount = mutation({
  args: {
    ...accountArgs,
    displayName: v.string(),
    scope: appleScope,
    expectedRevision: v.number(),
  },
  returns: appleAccount,
  handler: async (ctx, args) => {
    const { account } = await authorizeAppleAccount(ctx, args, true);
    const user = await requireUser(ctx);
    assertRevision(account.revision, args.expectedRevision);
    const companyId = await scopeCompany(ctx, args.scope);
    if (account.companyId !== companyId && account.ownerUserId !== user._id)
      throw backendError("permission-denied", "Only the account owner can change its scope.");
    if (account.companyId !== companyId) {
      const links = await ctx.db
        .query("appleProjectLinks")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .collect();
      if (links.length > 0)
        throw backendError(
          "entity-conflict",
          "Unlink projects before changing this Apple account's scope.",
        );
    }
    await ctx.db.patch(account._id, {
      displayName: bounded(args.displayName, 200),
      companyId,
      revision: account.revision + 1,
    });
    return await presentAccount(ctx, {
      ...account,
      displayName: args.displayName.trim(),
      companyId,
      revision: account.revision + 1,
    });
  },
});
export const removeAccount = mutation({
  args: { ...accountArgs, expectedRevision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { account } = await authorizeAppleAccount(ctx, args, true);
    assertRevision(account.revision, args.expectedRevision);
    const teams = await ctx.db
      .query("appleTeams")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();
    for (const team of teams) {
      const credential = await ctx.db
        .query("appleIntegrationCredentials")
        .withIndex("by_team", (q) => q.eq("teamId", team._id))
        .unique();
      if (credential) await ctx.db.delete(credential._id);
      for (const lease of await ctx.db
        .query("appleEnvironmentLeases")
        .withIndex("by_team", (q) => q.eq("teamId", team._id))
        .collect())
        await ctx.db.delete(lease._id);
      await ctx.db.delete(team._id);
    }
    for (const link of await ctx.db
      .query("appleProjectLinks")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect())
      await ctx.db.delete(link._id);
    for (const session of await ctx.db
      .query("appleAccountSessions")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect())
      await ctx.db.delete(session._id);
    await ctx.db.delete(account._id);
    return null;
  },
});
export const accountStatus = query({
  args: { ...accountArgs, companyId: v.optional(domainIdArg) },
  returns: appleAccount,
  handler: async (ctx, args) =>
    presentAccount(ctx, (await authorizeAppleAccount(ctx, args)).account),
});
export const listTeams = query({
  args: { ...accountArgs, companyId: v.optional(domainIdArg) },
  returns: v.array(appleTeam),
  handler: async (ctx, args) => {
    const { account } = await authorizeAppleAccount(ctx, args);
    return (
      await ctx.db
        .query("appleTeams")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .collect()
    ).map((t) => presentTeam(account.id, t));
  },
});
/** Manual team metadata until COR-101 discovers verified memberships during Apple ID sign-in. */
export const upsertTeam = mutation({
  args: { ...teamArgs, name: v.string(), type: appleTeamType },
  returns: appleTeam,
  handler: async (ctx, args) => {
    const { account } = await authorizeAppleAccount(ctx, args, true);
    if (!/^[A-Z0-9]{10}$/u.test(args.teamId))
      throw backendError(
        "invalid-arguments",
        "An Apple Developer team ID has ten uppercase letters or digits.",
      );
    const existing = await ctx.db
      .query("appleTeams")
      .withIndex("by_account_and_team", (q) =>
        q.eq("accountId", account._id).eq("teamId", args.teamId),
      )
      .unique();
    const fields = { name: bounded(args.name, 200), type: args.type };
    if (existing) await ctx.db.patch(existing._id, fields);
    else
      await ctx.db.insert("appleTeams", {
        accountId: account._id,
        teamId: args.teamId,
        ...fields,
        revision: 0,
        connected: false,
        issuerId: null,
        keyIdSuffix: null,
        lastVerifiedAt: null,
      });
    return { accountId: account.id, teamId: args.teamId, ...fields };
  },
});

const leaseFor = (
  ctx: QueryCtx,
  team: Doc<"appleTeams">,
  environmentId: string,
  companyId: Doc<"companies">["_id"],
) =>
  ctx.db
    .query("appleEnvironmentLeases")
    .withIndex("by_team_and_environment_and_company", (q) =>
      q.eq("teamId", team._id).eq("environmentId", environmentId).eq("companyId", companyId),
    )
    .unique();
export const status = query({
  args: { ...teamArgs, companyId: v.optional(domainIdArg) },
  returns: v.object({ integration: appleIntegration, environments: v.array(appleHealth) }),
  handler: async (ctx, args) => {
    const { account, team, actor } = await authorizeAppleTeam(ctx, args);
    const ownLease = actor
      ? await leaseFor(ctx, team, actor.registration.environmentId, actor.company._id)
      : null;
    const visible = actor
      ? ownLease === null
        ? []
        : [ownLease]
      : await ctx.db
          .query("appleEnvironmentLeases")
          .withIndex("by_team", (q) => q.eq("teamId", team._id))
          .collect();
    const environments = await Promise.all(
      visible.map(async (lease) => {
        const registration = await ctx.db
          .query("environmentRegistrations")
          .withIndex("by_company_and_environment", (q) =>
            q.eq("companyId", lease.companyId).eq("environmentId", lease.environmentId),
          )
          .unique();
        const current =
          team.connected &&
          team.revision === lease.revision &&
          account.revision === lease.accountRevision;
        return {
          environmentId: lease.environmentId,
          leaseExpiresAt: current ? lease.expiresAt : null,
          connected: current && lease.expiresAt > Date.now() && registration?.state === "active",
          revision: team.revision,
          lastVerifiedAt: current ? lease.lastVerifiedAt : null,
          error: current ? lease.error : null,
        };
      }),
    );
    return { integration: metadata(account, team), environments };
  },
});
export const authorizeManage = internalQuery({
  args: teamArgs,
  returns: v.object({ revision: v.number(), accountRevision: v.number() }),
  handler: async (ctx, args) => {
    const { account, team } = await authorizeAppleTeam(ctx, args, true);
    return { revision: team.revision, accountRevision: account.revision };
  },
});
const authorizeRef = makeFunctionReference<
  "query",
  TeamTarget,
  { revision: number; accountRevision: number }
>("appleIntegrations:authorizeManage");
type StoreArgs = {
  accountId: string;
  teamId: string;
  issuerId: string;
  keyIdSuffix: string;
  expectedRevision: number;
  accountRevision: number;
  lastVerifiedAt: number;
  keyId: string;
  iv: string;
  ciphertext: string;
  authenticationTag: string;
};
const storeRef = makeFunctionReference<"mutation", StoreArgs, Metadata>(
  "appleIntegrations:storeCredential",
);
function safeActionError(
  error: unknown,
): ConvexError<{ code: string; message: string; retryAfterSeconds: number | null }> {
  return new ConvexError(
    isAppleError(error)
      ? { code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds }
      : {
          code: "request-failed",
          message: "Could not complete the App Store Connect request.",
          retryAfterSeconds: null,
        },
  );
}
export const connect = action({
  args: {
    ...teamArgs,
    issuerId: v.string(),
    keyId: v.string(),
    privateKey: v.string(),
    expectedRevision: v.number(),
  },
  returns: appleIntegration,
  handler: async (ctx, args): Promise<Metadata> => {
    const before = await ctx.runQuery(authorizeRef, {
      accountId: args.accountId,
      teamId: args.teamId,
    });
    assertRevision(before.revision, args.expectedRevision);
    const credential = { issuerId: args.issuerId, keyId: args.keyId, privateKey: args.privateKey };
    const client = new AppStoreConnectClient(credential);
    try {
      await client.listApps();
    } catch (error) {
      throw safeActionError(error);
    } finally {
      client.dispose();
    }
    const sealed = await encryptIntegrationCredential(
      JSON.stringify(credential),
      aad(args.accountId, args.teamId, args.issuerId),
      integrationCredentialKeyringFromEnv(),
    );
    return await ctx.runMutation(storeRef, {
      accountId: args.accountId,
      teamId: args.teamId,
      issuerId: args.issuerId,
      keyIdSuffix: args.keyId.slice(-4),
      expectedRevision: args.expectedRevision,
      accountRevision: before.accountRevision,
      lastVerifiedAt: Date.now(),
      ...sealed,
    });
  },
});
export const storeCredential = internalMutation({
  args: {
    ...teamArgs,
    issuerId: v.string(),
    keyIdSuffix: v.string(),
    expectedRevision: v.number(),
    accountRevision: v.number(),
    lastVerifiedAt: v.number(),
    ...sealedAppleCredential,
  },
  returns: appleIntegration,
  handler: async (ctx, args) => {
    const { account, team } = await authorizeAppleTeam(ctx, args, true);
    assertRevision(team.revision, args.expectedRevision);
    assertRevision(account.revision, args.accountRevision);
    const values = {
      revision: team.revision + 1,
      connected: true,
      issuerId: args.issuerId,
      keyIdSuffix: args.keyIdSuffix,
      lastVerifiedAt: args.lastVerifiedAt,
    };
    await ctx.db.patch(team._id, values);
    const existing = await ctx.db
      .query("appleIntegrationCredentials")
      .withIndex("by_team", (q) => q.eq("teamId", team._id))
      .unique();
    const ciphertext = {
      teamId: team._id,
      keyId: args.keyId,
      iv: args.iv,
      ciphertext: args.ciphertext,
      authenticationTag: args.authenticationTag,
    };
    if (existing) await ctx.db.replace(existing._id, ciphertext);
    else await ctx.db.insert("appleIntegrationCredentials", ciphertext);
    return metadata(account, { ...team, ...values });
  },
});
export const revoke = mutation({
  args: { ...teamArgs, expectedRevision: v.number() },
  returns: appleIntegration,
  handler: async (ctx, args) => {
    const { account, team } = await authorizeAppleTeam(ctx, args, true);
    assertRevision(team.revision, args.expectedRevision);
    const credential = await ctx.db
      .query("appleIntegrationCredentials")
      .withIndex("by_team", (q) => q.eq("teamId", team._id))
      .unique();
    if (credential) await ctx.db.delete(credential._id);
    const values = {
      connected: false,
      revision: team.revision + 1,
      issuerId: null,
      keyIdSuffix: null,
      lastVerifiedAt: null,
    };
    await ctx.db.patch(team._id, values);
    return metadata(account, { ...team, ...values });
  },
});
export const heartbeat = mutation({
  args: runtimeArgs,
  returns: v.object({ integration: appleIntegration, expiresAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const { account, team, actor } = await authorizeAppleTeam(ctx, args);
    if (!actor) throw backendError("permission-denied", "Only environments may lease Apple keys.");
    if (!team.connected) return { integration: metadata(account, team), expiresAt: null };
    const existing = await leaseFor(ctx, team, actor.registration.environmentId, actor.company._id);
    const expiresAt = Date.now() + 30_000;
    const same =
      existing?.revision === team.revision && existing.accountRevision === account.revision;
    const values = {
      teamId: team._id,
      environmentId: actor.registration.environmentId,
      companyId: actor.company._id,
      accountRevision: account.revision,
      revision: team.revision,
      expiresAt,
      lastVerifiedAt: same ? existing.lastVerifiedAt : null,
      error: same ? existing.error : null,
    };
    if (existing) await ctx.db.replace(existing._id, values);
    else await ctx.db.insert("appleEnvironmentLeases", values);
    return { integration: metadata(account, team), expiresAt };
  },
});
async function leased(ctx: QueryCtx, args: LeaseTarget) {
  const access = await authorizeAppleTeam(ctx, args);
  const { account, team, actor } = access;
  if (!actor) throw backendError("permission-denied", "Only environments may lease Apple keys.");
  const lease = await leaseFor(ctx, team, actor.registration.environmentId, actor.company._id);
  if (
    !team.connected ||
    team.revision !== args.revision ||
    account.revision !== args.accountRevision ||
    lease?.revision !== args.revision ||
    lease.accountRevision !== args.accountRevision ||
    lease.expiresAt <= Date.now()
  )
    throw backendError(
      "stale-controller-lease",
      "The Apple credential lease is no longer current.",
    );
  return { ...access, lease };
}
export const runtimeCredentialRecord = internalQuery({
  args: revisionArgs,
  returns: v.object({ issuerId: v.string(), ...sealedAppleCredential }),
  handler: async (ctx, args) => {
    const { team } = await leased(ctx, args);
    return await credentialRecord(ctx, team);
  },
});
async function credentialRecord(ctx: QueryCtx, team: Doc<"appleTeams">) {
  const credential = await ctx.db
    .query("appleIntegrationCredentials")
    .withIndex("by_team", (q) => q.eq("teamId", team._id))
    .unique();
  if (!credential || !team.issuerId || !team.connected)
    throw backendError("credential-missing", "This Apple team has no connected key.");
  return {
    issuerId: team.issuerId,
    keyId: credential.keyId,
    iv: credential.iv,
    ciphertext: credential.ciphertext,
    authenticationTag: credential.authenticationTag,
  };
}
type CipherRecord = {
  issuerId: string;
  keyId: string;
  iv: string;
  ciphertext: string;
  authenticationTag: string;
};
const recordRef = makeFunctionReference<"query", LeaseTarget, CipherRecord>(
  "appleIntegrations:runtimeCredentialRecord",
);
async function unseal(target: TeamTarget, record: CipherRecord): Promise<AscCredential> {
  const plaintext = await decryptIntegrationCredential(
    record,
    aad(target.accountId, target.teamId, record.issuerId),
    integrationCredentialKeyringFromEnv(),
  );
  try {
    return decodeCredential(plaintext);
  } catch {
    throw backendError("invalid-credential", "The stored Apple credential is invalid.");
  }
}
export const runtimeCredential = action({
  args: revisionArgs,
  returns: v.object({ issuerId: v.string(), keyId: v.string(), privateKey: v.string() }),
  handler: async (ctx, args): Promise<AscCredential> => {
    const credential = await unseal(args, await ctx.runQuery(recordRef, args));
    await ctx.runQuery(recordRef, args);
    return credential;
  },
});
const healthMessages: Record<AppleFailure["code"], string> = {
  "not-connected": "Apple is disconnected.",
  "cloud-unavailable": "Pathway Cloud is unavailable.",
  unauthorized: "App Store Connect rejected the API key.",
  forbidden: "The API key does not have access to this resource.",
  "rate-limited": "App Store Connect rate limit reached.",
  "invalid-key": "The App Store Connect key is invalid.",
  "invalid-response": "App Store Connect returned an unexpected response.",
  "request-failed": "Could not complete the App Store Connect request.",
  "credential-changed": "The Apple connection changed. Retry the request.",
  "not-implemented": "Apple ID sign-in will be available with COR-101.",
};
export const updateHealth = mutation({
  args: {
    ...revisionArgs,
    lastVerifiedAt: v.union(v.number(), v.null()),
    error: v.union(appleFailure, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { lease } = await leased(ctx, args);
    await ctx.db.patch(lease._id, {
      lastVerifiedAt: args.lastVerifiedAt ?? lease.lastVerifiedAt,
      error:
        args.error === null
          ? null
          : {
              code: args.error.code,
              message: healthMessages[args.error.code],
              retryAfterSeconds: args.error.retryAfterSeconds,
            },
    });
    return null;
  },
});

const projectArgs = { companyId: domainIdArg, projectId: v.string() };
type ProjectTarget = { companyId: string; projectId: string };
async function projectAccess(ctx: QueryCtx, input: ProjectTarget, manage: boolean) {
  const actor = await requireCompanyActor(ctx, input.companyId);
  const project = await ctx.db
    .query("cloudProjects")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", actor.company._id).eq("id", input.projectId),
    )
    .unique();
  if (!project || project.deletedAt !== null)
    throw backendError("entity-not-found", "The project is unavailable.");
  requireRecordPermission(actor, manage ? "projects.manage" : "projects.read", project.teamIds);
  return { actor, project };
}
export const projectLink = query({
  args: projectArgs,
  returns: v.union(appleProjectLink, v.null()),
  handler: async (ctx, args) => {
    const { project } = await projectAccess(ctx, args, false);
    const link = await ctx.db
      .query("appleProjectLinks")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .unique();
    if (!link) return null;
    const account = await ctx.db.get(link.accountId);
    if (!account) return null;
    return {
      ...args,
      accountId: account.id,
      teamId: link.teamId,
      app: link.app,
      linkedAt: link.linkedAt,
    };
  },
});
export const unlinkProject = mutation({
  args: projectArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project } = await projectAccess(ctx, args, true);
    const link = await ctx.db
      .query("appleProjectLinks")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .unique();
    if (link) await ctx.db.delete(link._id);
    return null;
  },
});
async function linkAccess(ctx: QueryCtx, args: ProjectTarget & TeamTarget) {
  const project = await projectAccess(ctx, args, true);
  const access = await authorizeAppleTeam(ctx, args);
  if (access.account.companyId !== null && access.account.companyId !== project.actor.company._id)
    throw backendError("permission-denied", "The Apple account belongs to another company.");
  return { ...project, ...access };
}
export const prepareProjectLink = internalQuery({
  args: { ...projectArgs, ...teamArgs },
  returns: v.object({
    revision: v.number(),
    accountRevision: v.number(),
    credential: v.object({ issuerId: v.string(), ...sealedAppleCredential }),
  }),
  handler: async (ctx, args) => {
    const { account, team } = await linkAccess(ctx, args);
    return {
      revision: team.revision,
      accountRevision: account.revision,
      credential: await credentialRecord(ctx, team),
    };
  },
});
const prepareLinkRef = makeFunctionReference<
  "query",
  ProjectTarget & TeamTarget,
  { revision: number; accountRevision: number; credential: CipherRecord }
>("appleIntegrations:prepareProjectLink");
type LinkResult = ProjectTarget &
  TeamTarget & { app: { id: string; name: string; bundleId: string }; linkedAt: number };
const storeLinkRef = makeFunctionReference<
  "mutation",
  ProjectTarget &
    TeamTarget & { revision: number; accountRevision: number; app: LinkResult["app"] },
  LinkResult
>("appleIntegrations:storeProjectLink");
export const linkProject = action({
  args: { ...projectArgs, ...teamArgs, appId: v.string() },
  returns: appleProjectLink,
  handler: async (ctx, args): Promise<LinkResult> => {
    const target = {
      companyId: args.companyId,
      projectId: args.projectId,
      accountId: args.accountId,
      teamId: args.teamId,
    };
    const prepared = await ctx.runQuery(prepareLinkRef, target);
    const client = new AppStoreConnectClient(await unseal(args, prepared.credential));
    let app: LinkResult["app"] | undefined;
    try {
      app = (await client.listApps()).find((a) => a.id === args.appId);
    } catch (error) {
      throw safeActionError(error);
    } finally {
      client.dispose();
    }
    if (!app)
      throw backendError(
        "entity-not-found",
        "This app is not accessible with the selected team's key.",
      );
    return await ctx.runMutation(storeLinkRef, {
      ...target,
      revision: prepared.revision,
      accountRevision: prepared.accountRevision,
      app,
    });
  },
});
export const storeProjectLink = internalMutation({
  args: {
    ...projectArgs,
    ...teamArgs,
    revision: v.number(),
    accountRevision: v.number(),
    app: appleApp,
  },
  returns: appleProjectLink,
  handler: async (ctx, args) => {
    const { project, account, team } = await linkAccess(ctx, args);
    assertRevision(team.revision, args.revision);
    assertRevision(account.revision, args.accountRevision);
    if (!team.connected)
      throw backendError("credential-missing", "Connect the Apple team before linking an app.");
    const existing = await ctx.db
      .query("appleProjectLinks")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .unique();
    const values = {
      companyId: project.companyId,
      projectId: project._id,
      accountId: account._id,
      teamId: team.teamId,
      app: args.app,
      linkedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, values);
    else await ctx.db.insert("appleProjectLinks", values);
    return {
      companyId: args.companyId,
      projectId: args.projectId,
      accountId: args.accountId,
      teamId: args.teamId,
      app: args.app,
      linkedAt: values.linkedAt,
    };
  },
});
