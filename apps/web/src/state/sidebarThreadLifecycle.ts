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
import { readCloudSyncReset } from "../cloud/syncReset";
import { threadChangeRequestSource, type ThreadChangeRequestState } from "./threadPullRequest";

export const sidebarThreadScopeAtom = Atom.make((get) =>
  JSON.stringify([get(managedRelaySessionAtom)?.accountId ?? null, get(activeCompanyIdAtom)]),
);

/** Storage interface for the persisted classification cache; tests pass a plain object. */
export interface SidebarChangeRequestStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

function ambientLocalStorage(): SidebarChangeRequestStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Lives in the account's cloud-sync namespace so sign-out sweeps it with the rest. */
export function sidebarChangeRequestsStorageKey(scope: string): string | null {
  try {
    const [accountId, companyId] = JSON.parse(scope) as [unknown, unknown];
    if (typeof accountId !== "string" || accountId.trim() === "") return null;
    return `pathway:cloud-sync/${accountId.trim()}/sidebar-change-requests/${
      typeof companyId === "string" ? companyId : "all"
    }`;
  } catch {
    return null;
  }
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

export function readSidebarChangeRequests(
  scope: string,
  storage: SidebarChangeRequestStorage | null = ambientLocalStorage(),
): ReadonlyMap<string, ThreadChangeRequestState> {
  const key = sidebarChangeRequestsStorageKey(scope);
  if (key === null || storage === null) return new Map();
  try {
    const [accountId] = JSON.parse(scope) as [string];
    if (readCloudSyncReset(accountId.trim())) return new Map();
    const raw = storage.getItem(key);
    const decoded = raw ? Option.getOrNull(decodePersistedChangeRequests(raw)) : null;
    return new Map(decoded ? Object.entries(decoded) : []);
  } catch {
    return new Map();
  }
}

export function writeSidebarChangeRequests(
  scope: string,
  states: ReadonlyMap<string, ThreadChangeRequestState>,
  storage: SidebarChangeRequestStorage | null = ambientLocalStorage(),
): void {
  const key = sidebarChangeRequestsStorageKey(scope);
  if (key === null || storage === null) return;
  try {
    storage.setItem(
      key,
      encodePersistedChangeRequests(
        Object.fromEntries(
          [...states].map(([threadKey, { source, state, checkedAt }]) => [
            threadKey,
            checkedAt === undefined ? { source, state } : { source, state, checkedAt },
          ]),
        ),
      ),
    );
  } catch {
    // Quota or blocked storage only costs a reclassification after the next reload.
  }
}

// A background pass lands one result per thread; write at most once a second, latest value wins.
const queuedWrites = new Map<string, ReadonlyMap<string, ThreadChangeRequestState>>();
function persistSoon(scope: string, states: ReadonlyMap<string, ThreadChangeRequestState>) {
  const scheduled = queuedWrites.has(scope);
  queuedWrites.set(scope, states);
  if (scheduled) return;
  setTimeout(() => {
    const latest = queuedWrites.get(scope);
    queuedWrites.delete(scope);
    if (latest) writeSidebarChangeRequests(scope, latest);
  }, 1_000);
}

// Retain only classification data across navigation and reloads, not row components or VCS
// subscriptions. Scope by identity and company; idle scopes expire from memory (and reload from
// storage) and live scopes are pruned against shells.
export const sidebarThreadChangeRequestsAtom = Atom.family((scope: string) =>
  Atom.writable(
    (): ReadonlyMap<string, ThreadChangeRequestState> => readSidebarChangeRequests(scope),
    (ctx, value: ReadonlyMap<string, ThreadChangeRequestState>) => {
      ctx.setSelf(value);
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
