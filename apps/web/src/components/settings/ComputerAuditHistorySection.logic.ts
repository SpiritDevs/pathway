import {
  COMPUTER_AUDIT_HISTORY_MAX_LIMIT,
  type ComputerAuditHistoryEntry,
  type ComputerGetAuditHistoryResult,
} from "@spiritdevs/contracts";

export const COMPUTER_AUDIT_HISTORY_PAGE_SIZE = 30;

export const COMPUTER_AUDIT_EFFECT_LABELS: Readonly<
  Record<ComputerAuditHistoryEntry["effect"], string>
> = {
  verified: "Effect observed",
  "dispatched-unknown": "Sent; effect unconfirmed",
  "not-dispatched": "Not sent",
  refused: "Blocked",
  error: "Failed",
};

export type ComputerAuditHistoryPageRequest = {
  readonly before?: string;
  readonly limit: number;
};

/** The next older page, shrunk to what is left of the 100-row budget. */
export function nextComputerAuditHistoryPage(
  last: ComputerGetAuditHistoryResult,
  pages: readonly ComputerGetAuditHistoryResult[],
): ComputerAuditHistoryPageRequest | undefined {
  const remaining =
    COMPUTER_AUDIT_HISTORY_MAX_LIMIT -
    pages.reduce((count, page) => count + page.entries.length, 0);
  if (!last.nextCursor || remaining <= 0) return undefined;
  return {
    before: last.nextCursor,
    limit: Math.min(COMPUTER_AUDIT_HISTORY_PAGE_SIZE, remaining),
  };
}

/** Loaded rows, deduplicated across pages and bounded for the UI. */
export function computerAuditHistoryEntries(
  pages: readonly ComputerGetAuditHistoryResult[],
): readonly ComputerAuditHistoryEntry[] {
  return [
    ...new Map(pages.flatMap((page) => page.entries).map((entry) => [entry.id, entry])).values(),
  ].slice(0, COMPUTER_AUDIT_HISTORY_MAX_LIMIT);
}
