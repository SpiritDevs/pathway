// @effect-diagnostics globalDate:off -- Convex transaction time and bounded credential leases.
import { v } from "cyndrbase/values";
import { makeFunctionReference } from "cyndrbase/server";
import * as Schema from "effect/Schema";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import { authorizeAppleAccount } from "./lib/appleIdentity.ts";
import { backendError } from "./lib/errors.ts";
import { domainIdArg } from "./lib/validators.ts";
import { appleTeamType, sealedAppleCredential } from "./lib/appleValidators.ts";
import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  integrationCredentialKeyringFromEnv,
} from "../src/integrationCredentials.ts";
import {
  AppleSessionCredential,
  type AppleSessionMetadata,
  type AppleSessionTarget,
} from "../src/appleSession.ts";

const targetArgs = { companyId: domainIdArg, accountId: v.string() };
const revisionArgs = { ...targetArgs, accountRevision: v.number(), revision: v.number() };
const metadataValidator = v.object({
  email: v.string(),
  accountRevision: v.number(),
  revision: v.number(),
  expiresAt: v.union(v.number(), v.null()),
});
const credentialValidator = v.object({
  cookies: v.array(
    v.object({
      key: v.string(),
      value: v.string(),
      domain: v.string(),
      path: v.string(),
      secure: v.boolean(),
      httpOnly: v.boolean(),
      expires: v.union(v.number(), v.null()),
    }),
  ),
});
const teamValidator = v.object({ teamId: v.string(), name: v.string(), type: appleTeamType });
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(AppleSessionCredential));
const aad = (accountId: string) => ({
  companyId: `apple-account:${accountId}`,
  integrationId: "apple-id-session",
  workspaceId: "v1",
});
async function access(ctx: QueryCtx, target: AppleSessionTarget) {
  const value = await authorizeAppleAccount(ctx, target);
  if (!value.actor)
    throw backendError("permission-denied", "Only linked environments may use Apple ID sessions.");
  const record = await ctx.db
    .query("appleAccountSessions")
    .withIndex("by_account", (q) => q.eq("accountId", value.account._id))
    .unique();
  return { ...value, record };
}
function metadata({ account, record }: Awaited<ReturnType<typeof access>>): AppleSessionMetadata {
  return {
    email: account.email,
    accountRevision: account.revision,
    revision: account.sessionRevision ?? 0,
    expiresAt: record && record.accountRevision === account.revision ? record.expiresAt : null,
  };
}
function check(
  current: AppleSessionMetadata,
  expected: { accountRevision: number; revision: number },
) {
  if (
    current.accountRevision !== expected.accountRevision ||
    current.revision !== expected.revision
  )
    throw backendError("entity-conflict", "The Apple ID session changed. Sign in again.");
}
export const status = query({
  args: targetArgs,
  returns: metadataValidator,
  handler: async (ctx, args) => metadata(await access(ctx, args)),
});
export const prepare = internalQuery({
  args: revisionArgs,
  returns: metadataValidator,
  handler: async (ctx, args) => {
    const value = metadata(await access(ctx, args));
    check(value, args);
    return value;
  },
});
const prepareRef = makeFunctionReference<
  "query",
  AppleSessionTarget & { accountRevision: number; revision: number },
  AppleSessionMetadata
>("appleSessions:prepare");
export const store = internalMutation({
  args: {
    ...revisionArgs,
    ...sealedAppleCredential,
    expiresAt: v.number(),
    teams: v.array(teamValidator),
  },
  returns: metadataValidator,
  handler: async (ctx, args) => {
    const current = await access(ctx, args);
    check(metadata(current), args);
    if (
      args.expiresAt <= Date.now() ||
      args.expiresAt > Date.now() + 8 * 60 * 60 * 1000 ||
      args.teams.length > 100
    )
      throw backendError("invalid-arguments", "The Apple session expiry or team list is invalid.");
    const values = {
      accountId: current.account._id,
      accountRevision: args.accountRevision,
      revision: args.revision + 1,
      expiresAt: args.expiresAt,
      keyId: args.keyId,
      iv: args.iv,
      ciphertext: args.ciphertext,
      authenticationTag: args.authenticationTag,
    };
    if (current.record) await ctx.db.replace(current.record._id, values);
    else await ctx.db.insert("appleAccountSessions", values);
    await ctx.db.patch(current.account._id, {
      verifiedAt: Date.now(),
      sessionRevision: args.revision + 1,
    });
    for (const team of args.teams) {
      const existing = await ctx.db
        .query("appleTeams")
        .withIndex("by_account_and_team", (q) =>
          q.eq("accountId", current.account._id).eq("teamId", team.teamId),
        )
        .unique();
      if (existing) await ctx.db.patch(existing._id, { name: team.name, type: team.type });
      else
        await ctx.db.insert("appleTeams", {
          accountId: current.account._id,
          ...team,
          revision: 0,
          connected: false,
          issuerId: null,
          keyIdSuffix: null,
          lastVerifiedAt: null,
        });
    }
    return { ...metadata(current), revision: values.revision, expiresAt: values.expiresAt };
  },
});
type StoreInput = AppleSessionTarget & {
  accountRevision: number;
  revision: number;
  expiresAt: number;
  teams: {
    teamId: string;
    name: string;
    type: "individual" | "organization" | "enterprise" | "unknown";
  }[];
  keyId: string;
  iv: string;
  ciphertext: string;
  authenticationTag: string;
};
const storeRef = makeFunctionReference<"mutation", StoreInput, AppleSessionMetadata>(
  "appleSessions:store",
);
export const save = action({
  args: {
    ...revisionArgs,
    credential: credentialValidator,
    expiresAt: v.number(),
    teams: v.array(teamValidator),
  },
  returns: metadataValidator,
  handler: async (ctx, args): Promise<AppleSessionMetadata> => {
    await ctx.runQuery(prepareRef, {
      companyId: args.companyId,
      accountId: args.accountId,
      accountRevision: args.accountRevision,
      revision: args.revision,
    });
    const plaintext = JSON.stringify(args.credential);
    if (
      plaintext.length > 64 * 1024 ||
      args.credential.cookies.length === 0 ||
      args.credential.cookies.some(
        (c) => !c.secure || !/^\.?([a-z0-9-]+\.)*apple\.com$/i.test(c.domain),
      )
    )
      throw backendError("invalid-arguments", "The Apple session cookies are invalid.");
    const sealed = await encryptIntegrationCredential(
      plaintext,
      aad(args.accountId),
      integrationCredentialKeyringFromEnv(),
    );
    return await ctx.runMutation(storeRef, {
      companyId: args.companyId,
      accountId: args.accountId,
      accountRevision: args.accountRevision,
      revision: args.revision,
      expiresAt: args.expiresAt,
      teams: args.teams,
      ...sealed,
    });
  },
});
export const record = internalQuery({
  args: targetArgs,
  handler: async (ctx, args) => {
    const value = await access(ctx, args);
    const meta = metadata(value);
    if (!value.record || meta.expiresAt === null || meta.expiresAt <= Date.now())
      throw backendError("credential-missing", "Sign in to the Apple account again.");
    return {
      ...meta,
      sealed: {
        keyId: value.record.keyId,
        iv: value.record.iv,
        ciphertext: value.record.ciphertext,
        authenticationTag: value.record.authenticationTag,
      },
    };
  },
});
const recordRef = makeFunctionReference<
  "query",
  AppleSessionTarget,
  AppleSessionMetadata & {
    sealed: { keyId: string; iv: string; ciphertext: string; authenticationTag: string };
  }
>("appleSessions:record");
export const read = action({
  args: targetArgs,
  handler: async (ctx, args) => {
    const before = await ctx.runQuery(recordRef, args);
    const credential = decode(
      await decryptIntegrationCredential(
        before.sealed,
        aad(args.accountId),
        integrationCredentialKeyringFromEnv(),
      ),
    );
    const after = await ctx.runQuery(recordRef, args);
    check(after, before);
    return {
      email: after.email,
      accountRevision: after.accountRevision,
      revision: after.revision,
      expiresAt: after.expiresAt,
      leaseExpiresAt: Math.min(after.expiresAt!, Date.now() + 30_000),
      credential,
    };
  },
});
export const revoke = mutation({
  args: { ...targetArgs, revision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await access(ctx, args);
    if ((current.account.sessionRevision ?? 0) !== args.revision)
      throw backendError("entity-conflict", "The Apple ID session changed.");
    if (current.record) await ctx.db.delete(current.record._id);
    await ctx.db.patch(current.account._id, { sessionRevision: args.revision + 1 });
    return null;
  },
});
