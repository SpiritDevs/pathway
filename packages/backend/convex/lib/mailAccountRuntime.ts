import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { mailAccountRuntimeFields } from "./mailSchema.ts";

type AccountPatch = {
  [Key in Exclude<
    keyof Doc<"mailAccounts">,
    "_id" | "_creationTime"
  >]?: undefined extends Doc<"mailAccounts">[Key]
    ? Doc<"mailAccounts">[Key] | undefined
    : Doc<"mailAccounts">[Key];
};
type RuntimeKey = keyof typeof mailAccountRuntimeFields;
const keys = Object.keys(mailAccountRuntimeFields) as RuntimeKey[];
const runtimeFields = (row: Pick<Doc<"mailAccounts">, RuntimeKey>) =>
  Object.fromEntries(keys.map((key) => [key, row[key]])) as Pick<Doc<"mailAccounts">, RuntimeKey>;
const findRuntime = (ctx: QueryCtx, account: Doc<"mailAccounts">) =>
  ctx.db
    .query("mailAccountRuntime")
    .withIndex("by_account", (q) => q.eq("accountId", account._id))
    .unique();

/** Authorization and UI readers deliberately keep using the cold account alone. */
export async function withMailAccountRuntime(ctx: QueryCtx, account: Doc<"mailAccounts">) {
  const row = await findRuntime(ctx, account);
  return row ? { ...account, ...runtimeFields(row) } : account;
}

/** Split account changes atomically, retaining legacy fields only as a migration fallback. */
export async function patchMailAccount(
  ctx: MutationCtx,
  account: Doc<"mailAccounts">,
  patch: AccountPatch,
) {
  const runtime = await findRuntime(ctx, account);
  const hotPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => keys.includes(key as RuntimeKey)),
  ) as Pick<AccountPatch, RuntimeKey>;
  const coldPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => !keys.includes(key as RuntimeKey)),
  ) as AccountPatch;
  const mirrored = {
    companyId: patch.companyId ?? account.companyId,
    status: patch.status ?? account.status,
    primaryEnvironmentId:
      "primaryEnvironmentId" in patch ? patch.primaryEnvironmentId : account.primaryEnvironmentId,
    backupEnvironmentId:
      "backupEnvironmentId" in patch ? patch.backupEnvironmentId : account.backupEnvironmentId,
  };
  if (runtime) {
    const changedMirrors = Object.fromEntries(
      Object.entries(mirrored).filter(
        ([key, value]) => runtime[key as keyof typeof mirrored] !== value,
      ),
    );
    if (Object.keys(hotPatch).length || Object.keys(changedMirrors).length)
      await ctx.db.patch(runtime._id, { ...hotPatch, ...changedMirrors });
  } else {
    const initial = { accountId: account._id, ...mirrored, ...runtimeFields(account), ...hotPatch };
    // Inserts omit absent optional fields; patches retain undefined to clear them.
    await ctx.db.insert(
      "mailAccountRuntime",
      Object.fromEntries(
        Object.entries(initial).filter(([, value]) => value !== undefined),
      ) as Omit<Doc<"mailAccountRuntime">, "_id" | "_creationTime">,
    );
    coldPatch.runtimeMigrated = true;
  }
  if (Object.keys(coldPatch).length) await ctx.db.patch(account._id, coldPatch);
}

async function joinRuntime(ctx: QueryCtx, rows: Doc<"mailAccountRuntime">[]) {
  const accounts = await Promise.all(
    rows.map(async (row) => {
      const account = await ctx.db.get(row.accountId);
      return account ? { ...account, ...runtimeFields(row) } : null;
    }),
  );
  return accounts.filter((account) => account !== null);
}

export async function dueMailAccounts(ctx: QueryCtx, now: number, limit: number) {
  const [runtime, legacy] = await Promise.all([
    ctx.db
      .query("mailAccountRuntime")
      .withIndex("by_due", (q) => q.eq("status", "active").lte("nextSyncAt", now))
      .take(limit),
    ctx.db
      .query("mailAccounts")
      .withIndex("by_legacy_due", (q) =>
        q.eq("runtimeMigrated", undefined).eq("status", "active").lte("nextSyncAt", now),
      )
      .take(limit),
  ]);
  return [...(await joinRuntime(ctx, runtime)), ...legacy]
    .sort((a, b) => a.nextSyncAt - b.nextSyncAt)
    .slice(0, limit);
}

export async function mailAuthorizationCandidates(ctx: QueryCtx, limit: number) {
  const [runtime, legacy] = await Promise.all([
    ctx.db.query("mailAccountRuntime").withIndex("by_auth_check").take(limit),
    ctx.db
      .query("mailAccounts")
      .withIndex("by_legacy", (q) => q.eq("runtimeMigrated", undefined))
      .take(limit),
  ]);
  return [...(await joinRuntime(ctx, runtime)), ...legacy]
    .sort((a, b) => a.lastAuthCheckAt - b.lastAuthCheckAt)
    .slice(0, limit);
}

export async function mailWorkerAccounts(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  environmentId: string,
  role: "primary" | "backup",
  limit: number,
) {
  const runtimeQuery =
    role === "primary"
      ? ctx.db
          .query("mailAccountRuntime")
          .withIndex("by_primary", (q) =>
            q.eq("companyId", companyId).eq("primaryEnvironmentId", environmentId),
          )
      : ctx.db
          .query("mailAccountRuntime")
          .withIndex("by_backup", (q) =>
            q.eq("companyId", companyId).eq("backupEnvironmentId", environmentId),
          );
  const legacyQuery =
    role === "primary"
      ? ctx.db
          .query("mailAccounts")
          .withIndex("by_legacy_primary", (q) =>
            q
              .eq("runtimeMigrated", undefined)
              .eq("companyId", companyId)
              .eq("primaryEnvironmentId", environmentId),
          )
      : ctx.db
          .query("mailAccounts")
          .withIndex("by_legacy_backup", (q) =>
            q
              .eq("runtimeMigrated", undefined)
              .eq("companyId", companyId)
              .eq("backupEnvironmentId", environmentId),
          );
  const [runtime, legacy] = await Promise.all([runtimeQuery.take(limit), legacyQuery.take(limit)]);
  return [...(await joinRuntime(ctx, runtime)), ...legacy]
    .sort((a, b) => a.lastClaimAt - b.lastClaimAt)
    .slice(0, limit);
}
