import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/models";
import {
  effectiveSettled,
  effectiveSnoozed,
} from "@spiritdevs/client-runtime/state/thread-settled";
import { threadPullRequestAttachments } from "@spiritdevs/shared/sourceControl";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { activeCompanyIdAtom } from "../cloud/activeCompany";
import { readCloudSyncReset, type SyncResetStorage } from "../cloud/syncReset";
import { threadChangeRequestSource, type ThreadChangeRequestState } from "./threadPullRequest";

export const sidebarThreadScopeAtom = Atom.make((get) =>
  JSON.stringify([get(managedRelaySessionAtom)?.accountId ?? null, get(activeCompanyIdAtom)]),
);

function ambientLocalStorage(): SyncResetStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function scopeParts(
  scope: string,
): { readonly accountId: string; readonly company: string } | null {
  try {
    const [accountId, companyId] = JSON.parse(scope) as [unknown, unknown];
    if (typeof accountId !== "string" || accountId.trim() === "") return null;
    return {
      accountId: accountId.trim(),
      company: typeof companyId === "string" ? companyId : "all",
    };
  } catch {
    return null;
  }
}

// Every key the cache owns for an account starts with this prefix, so sign-out can sweep them all.
const accountPrefix = (accountId: string) =>
  `pathway:cloud-sync/${accountId}/sidebar-change-requests`;
const companyKey = (accountId: string, company: string) => `${accountPrefix(accountId)}/${company}`;
// Most recently written companies first. Tabs update it without a lock, so writes reconcile it
// against the company caches actually stored.
const recentCompaniesKey = (accountId: string) => `${accountPrefix(accountId)}-recent`;
const RECENT_COMPANY_LIMIT = 4;

function storedKeys(storage: SyncResetStorage, prefix: string): string[] {
  // Copy first: mutating a live Storage key list while iterating it skips entries.
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/**
 * Lives in the account's cloud-sync namespace, so the sync runtime's sign-out reset sweeps it with
 * the rest; sign-out also clears it at once (`clearSidebarChangeRequests`).
 */
export function sidebarChangeRequestsStorageKey(scope: string): string | null {
  const parts = scopeParts(scope);
  return parts && companyKey(parts.accountId, parts.company);
}

// Only classification is persisted; badge presentation is refetched by visible rows.
const PersistedChangeRequests = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      source: Schema.String,
      state: Schema.NullOr(Schema.Literals(["open", "closed", "merged"])),
      checkedAt: Schema.optional(Schema.Number),
    }),
  ),
);
const decodePersistedChangeRequests = Schema.decodeUnknownOption(PersistedChangeRequests);
const encodePersistedChangeRequests = Schema.encodeSync(PersistedChangeRequests);
const RecentCompanies = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeRecentCompanies = Schema.decodeUnknownOption(RecentCompanies);
const encodeRecentCompanies = Schema.encodeSync(RecentCompanies);

function readRecentCompanies(storage: SyncResetStorage, accountId: string): readonly string[] {
  const raw = storage.getItem(recentCompaniesKey(accountId));
  return (raw ? Option.getOrNull(decodeRecentCompanies(raw)) : null) ?? [];
}

export function readSidebarChangeRequests(
  scope: string,
  storage: SyncResetStorage | null = ambientLocalStorage(),
): ReadonlyMap<string, ThreadChangeRequestState> {
  const parts = scopeParts(scope);
  if (parts === null || storage === null) return new Map();
  try {
    // A sign-out reset is pending until the sync runtime has swept the namespace.
    if (readCloudSyncReset(parts.accountId, storage)) return new Map();
    const key = companyKey(parts.accountId, parts.company);
    const raw = storage.getItem(key);
    const decoded = raw ? Option.getOrNull(decodePersistedChangeRequests(raw)) : null;
    return new Map(decoded ? Object.entries(decoded) : []);
  } catch {
    return new Map();
  }
}

let warnedWriteFailure = false;

/** Writes one company's classification; companies beyond the most recent few are evicted. */
export function writeSidebarChangeRequests(
  scope: string,
  states: ReadonlyMap<string, ThreadChangeRequestState>,
  storage: SyncResetStorage | null = ambientLocalStorage(),
): void {
  const parts = scopeParts(scope);
  if (parts === null || storage === null) return;
  const { accountId, company } = parts;
  try {
    // Evict before writing so an inactive company's cache frees room for the active one. Caches
    // another tab stored but dropped from the index count as least recent, so they still evict.
    const companyPrefix = companyKey(accountId, "");
    const stored = storedKeys(storage, companyPrefix).map((item) =>
      item.slice(companyPrefix.length),
    );
    const recent = [
      ...new Set([
        company,
        ...readRecentCompanies(storage, accountId).filter((item) => stored.includes(item)),
        ...stored,
      ]),
    ];
    for (const evicted of recent.slice(RECENT_COMPANY_LIMIT))
      storage.removeItem(companyKey(accountId, evicted));
    storage.setItem(
      recentCompaniesKey(accountId),
      encodeRecentCompanies(recent.slice(0, RECENT_COMPANY_LIMIT)),
    );
    storage.setItem(
      companyKey(accountId, company),
      encodePersistedChangeRequests(
        Object.fromEntries(
          [...states].map(([threadKey, { source, state, checkedAt }]) => [
            threadKey,
            checkedAt === undefined ? { source, state } : { source, state, checkedAt },
          ]),
        ),
      ),
    );
  } catch (error) {
    // Quota or blocked storage only costs a reclassification after the next reload; the next
    // write tries again.
    if (!warnedWriteFailure) {
      warnedWriteFailure = true;
      console.warn("Could not save sidebar PR classification.", error);
    }
  }
}

// A background pass lands one result per thread; write at most once a second, latest value wins.
const queuedWrites = new Map<
  string,
  {
    states: ReadonlyMap<string, ThreadChangeRequestState>;
    readonly timer: ReturnType<typeof setTimeout>;
  }
>();
function persistSoon(scope: string, states: ReadonlyMap<string, ThreadChangeRequestState>) {
  const queued = queuedWrites.get(scope);
  if (queued) {
    queued.states = states;
    return;
  }
  queuedWrites.set(scope, {
    states,
    timer: setTimeout(() => {
      const latest = queuedWrites.get(scope);
      queuedWrites.delete(scope);
      if (latest) writeSidebarChangeRequests(scope, latest.states);
    }, 1_000),
  });
}

/**
 * Sign-out: drops the account's queued writes and removes its persisted classification, so a
 * delayed write cannot land after the account is gone.
 */
export function clearSidebarChangeRequests(
  accountId: string,
  storage: SyncResetStorage | null = ambientLocalStorage(),
): void {
  const account = accountId.trim();
  for (const [scope, queued] of queuedWrites) {
    if (scopeParts(scope)?.accountId !== account) continue;
    clearTimeout(queued.timer);
    queuedWrites.delete(scope);
  }
  if (storage === null || account === "") return;
  try {
    // Sweep by prefix, not the index: another tab may have stored a company the index misses.
    for (const key of storedKeys(storage, accountPrefix(account))) storage.removeItem(key);
  } catch {
    // Whatever remains is this account's own classification, rechecked in the background.
  }
}

// Retain only classification data across navigation and reloads, not row components or VCS
// subscriptions. Scope by identity and company; idle scopes expire from memory (and reload from
// storage) and live scopes are pruned against shells. Only the signed-in account's scope persists:
// a check that lands after sign-out updates memory alone.
export const sidebarThreadChangeRequestsAtom = Atom.family((scope: string) =>
  Atom.writable(
    (): ReadonlyMap<string, ThreadChangeRequestState> => readSidebarChangeRequests(scope),
    (ctx, value: ReadonlyMap<string, ThreadChangeRequestState>) => {
      ctx.setSelf(value);
      const accountId = ctx.get(managedRelaySessionAtom)?.accountId.trim();
      if (accountId !== undefined && accountId === scopeParts(scope)?.accountId)
        persistSoon(scope, value);
    },
  ).pipe(Atom.setIdleTTL("30 minutes")),
);

export function updateSidebarChangeRequest(
  current: ReadonlyMap<string, ThreadChangeRequestState>,
  key: string,
  value: ThreadChangeRequestState,
  failed = false,
): ReadonlyMap<string, ThreadChangeRequestState> {
  const previous = current.get(key);
  if (
    previous?.source === value.source &&
    (failed ||
      (previous.state === value.state &&
        (previous.presentation === value.presentation ||
          JSON.stringify(previous.presentation) === JSON.stringify(value.presentation)) &&
        value.checkedAt === undefined))
  )
    return current;
  return new Map(current).set(key, {
    ...value,
    checkedAt: failed ? undefined : (value.checkedAt ?? Date.now()),
  });
}

export type SidebarThreadSection = "active" | "pinned" | "snoozed" | "settled";

export interface SidebarThreadPlacement {
  readonly section: SidebarThreadSection;
  /** Placed without a PR answer the section depends on; the background check may move it. */
  readonly provisional: boolean;
}

// Every admitted head renders immediately. Capabilities still loading count as supported, and an
// unknown PR status gets a provisional section instead of hiding the row.
export function sidebarThreadSection(
  thread: EnvironmentThreadShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly queued: boolean;
    /** The thread has news the user has not opened yet (the sidebar's blue dot). */
    readonly unread?: boolean;
    readonly supportsSettlement: boolean | undefined;
    readonly supportsSnooze: boolean | undefined;
    readonly projectCwd: string | null;
    readonly changeRequests: ReadonlyMap<string, ThreadChangeRequestState>;
  },
): SidebarThreadPlacement {
  const placed = (section: SidebarThreadSection, provisional = false) => ({
    section,
    provisional,
  });
  if (options.queued && thread.pinnedAt == null) return placed("active");
  if (options.supportsSnooze !== false && effectiveSnoozed(thread, { now: options.now }))
    return placed("snoozed");
  if (thread.pinnedAt != null) return placed("pinned");
  // Unseen news never settles out of view; once it is read the thread settles as usual.
  if (options.unread) return placed("active");
  if (options.supportsSettlement === false) return placed("active");

  const cached = options.changeRequests.get(
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  const settleOptions = { now: options.now, autoSettleAfterDays: options.autoSettleAfterDays };
  const settled = (changeRequestState: ThreadChangeRequestState["state"]) =>
    effectiveSettled(thread, { ...settleOptions, changeRequestState });
  if (cached?.source === threadChangeRequestSource(thread))
    return placed(settled(cached.state) ? "settled" : "active");
  const hasChangeRequestSource =
    threadPullRequestAttachments(thread).length > 0 ||
    (thread.branch !== null && (thread.worktreePath ?? options.projectCwd) !== null);
  // Running work, explicit overrides and threads with no PR source need no status lookup.
  const needsChangeRequest =
    hasChangeRequestSource &&
    (settled(null) !== settled("merged") || settled(null) !== settled("open"));
  // Until the background check answers, the shared rule places the thread with no PR state: an
  // attached PR keeps it Active, and a branch alone falls back to the age rule, so quiet branch
  // history waits in Settled instead of flooding Active and an open PR found later brings it back.
  return placed(settled(null) ? "settled" : "active", needsChangeRequest);
}
