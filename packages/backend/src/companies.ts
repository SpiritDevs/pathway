/**
 * Company lifecycle and policy arithmetic.
 *
 * @module companies
 */

export const COMPANY_LIFECYCLE_STATES = ["active", "deletionScheduled", "purged"] as const;
export type CompanyLifecycleState = (typeof COMPANY_LIFECYCLE_STATES)[number];

export const WORKSPACE_KINDS = ["personal", "organization"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const MEMBERSHIP_STATES = ["active", "locked", "left"] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

/** Deletion disables access immediately and stays owner-restorable for this long. */
export const COMPANY_DELETION_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;

export const OFFLINE_ACCESS_DEFAULT_DAYS = 30;
export const OFFLINE_ACCESS_MIN_DAYS = 0;
export const OFFLINE_ACCESS_MAX_DAYS = 90;

export const COMPANY_NAME_MAX_CHARS = 120;
export const ISSUE_KEY_PREFIX_MAX_CHARS = 8;

/** A fresh tracker must have somewhere to place its first issue. */
export { DEFAULT_ISSUE_STATUSES } from "@spiritdevs/contracts";

export function clampOfflineAccessDays(days: number): number {
  if (!Number.isFinite(days)) return OFFLINE_ACCESS_DEFAULT_DAYS;
  const whole = Math.trunc(days);
  if (whole < OFFLINE_ACCESS_MIN_DAYS) return OFFLINE_ACCESS_MIN_DAYS;
  if (whole > OFFLINE_ACCESS_MAX_DAYS) return OFFLINE_ACCESS_MAX_DAYS;
  return whole;
}

export function companyPurgeAfter(deletionScheduledAt: number): number {
  return deletionScheduledAt + COMPANY_DELETION_RECOVERY_MS;
}

export function isCompanyPurgeDue(purgeAfter: number, now: number): boolean {
  return now >= purgeAfter;
}

export function normalizeCompanyName(name: string): string {
  return name.trim().slice(0, COMPANY_NAME_MAX_CHARS);
}

/**
 * The prefix a freshly created company starts with. Letters only and upper-cased, because it is
 * the human-facing half of an issue key that will never change once keys are handed out.
 */
export function defaultIssueKeyPrefix(companyName: string): string {
  const letters = companyName.toUpperCase().replace(/[^A-Z]/g, "");
  const prefix = letters.slice(0, 3);
  return prefix.length > 0 ? prefix : "PW";
}

export function normalizeIssueKeyPrefix(prefix: string): string {
  return prefix
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ISSUE_KEY_PREFIX_MAX_CHARS);
}

/**
 * Cached grants are refreshed after every successful authorization; a zero-day setting means the
 * company can never be opened without an online check, so it never produces a grant.
 */
export function offlineGrantExpiresAt(now: number, offlineAccessDays: number): number | null {
  const days = clampOfflineAccessDays(offlineAccessDays);
  return days === 0 ? null : now + days * 24 * 60 * 60 * 1000;
}
