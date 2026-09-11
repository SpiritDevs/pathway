import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/models";
import {
  effectiveSettled,
  effectiveSnoozed,
} from "@spiritdevs/client-runtime/state/thread-settled";
import { threadPullRequestAttachments } from "@spiritdevs/shared/sourceControl";
import { Atom } from "effect/unstable/reactivity";

import { activeCompanyIdAtom } from "../cloud/activeCompany";
import { threadChangeRequestSource, type ThreadChangeRequestState } from "./threadPullRequest";

export const sidebarThreadScopeAtom = Atom.make((get) =>
  JSON.stringify([get(managedRelaySessionAtom)?.accountId ?? null, get(activeCompanyIdAtom)]),
);

// Retain only classification data across navigation, not row components or VCS subscriptions.
// Scope by identity and company; idle scopes expire and live scopes are pruned against shells.
export const sidebarThreadChangeRequestsAtom = Atom.family((_scope: string) =>
  Atom.make<ReadonlyMap<string, ThreadChangeRequestState>>(new Map()).pipe(
    Atom.setIdleTTL("30 minutes"),
  ),
);

export function updateSidebarChangeRequest(
  current: ReadonlyMap<string, ThreadChangeRequestState>,
  key: string,
  value: ThreadChangeRequestState,
  failed = false,
): ReadonlyMap<string, ThreadChangeRequestState> {
  const previous = current.get(key);
  if (previous?.source === value.source && (failed || previous.state === value.state))
    return current;
  return new Map(current).set(key, value);
}

export type SidebarThreadSection = "active" | "pinned" | "snoozed" | "settled" | "loading";

export function sidebarThreadSection(
  thread: EnvironmentThreadShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly queued: boolean;
    readonly supportsSettlement: boolean | undefined;
    readonly supportsSnooze: boolean | undefined;
    readonly unavailable?: boolean;
    readonly projectCwd: string | null;
    readonly changeRequests: ReadonlyMap<string, ThreadChangeRequestState>;
  },
): SidebarThreadSection {
  if (options.queued && thread.pinnedAt == null) return "active";
  const snoozed = effectiveSnoozed(thread, { now: options.now });
  if (snoozed && options.supportsSnooze === undefined && !options.unavailable) return "loading";
  if (snoozed && options.supportsSnooze) return "snoozed";
  if (thread.pinnedAt != null) return "pinned";
  if (options.supportsSettlement === false) return "active";

  const cached = options.changeRequests.get(
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  const known = cached?.source === threadChangeRequestSource(thread);
  const settleOptions = { now: options.now, autoSettleAfterDays: options.autoSettleAfterDays };
  const settled = (changeRequestState: ThreadChangeRequestState["state"]) =>
    effectiveSettled(thread, { ...settleOptions, changeRequestState });
  if (options.supportsSettlement && known) return settled(cached.state) ? "settled" : "active";
  // A missing remote answer must never make a navigable thread disappear during an outage.
  if (options.unavailable) {
    return options.supportsSettlement && thread.settledOverride === "settled" && settled(null)
      ? "settled"
      : "active";
  }
  const hasChangeRequestSource =
    threadPullRequestAttachments(thread).length > 0 ||
    (thread.branch !== null && (thread.worktreePath ?? options.projectCwd) !== null);
  // Running work, explicit overrides and threads with no PR source need no status lookup.
  const needsChangeRequest =
    hasChangeRequestSource &&
    (settled(null) !== settled("merged") || settled(null) !== settled("open"));
  if (options.supportsSettlement === undefined && (settled(null) || needsChangeRequest)) {
    return "loading";
  }
  if (!options.supportsSettlement) return "active";
  if (needsChangeRequest && !known) return "loading";
  return settled(known ? cached.state : null) ? "settled" : "active";
}
