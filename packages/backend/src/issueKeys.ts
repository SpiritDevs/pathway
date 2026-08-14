/**
 * Issue key leasing. Keys are immutable and sequential per company, so a client leases a block
 * while online and spends it offline. Unspent numbers are never recycled — a gap in the sequence
 * is cheaper than a key that means two different issues.
 *
 * @module issueKeys
 */

export const ISSUE_KEY_BLOCK_SIZE = 25;
/** Ask for the next block while this many numbers remain, so a client rarely runs dry online. */
export const ISSUE_KEY_REPLENISH_THRESHOLD = 5;

/** Shown in place of a key when a client exhausts its block offline; the issue id stays stable. */
export const ISSUE_KEY_DRAFT_PLACEHOLDER = "Draft";

export interface IssueKeyBlock {
  readonly blockStart: number;
  readonly blockEnd: number;
}

export interface IssueKeyReservation {
  readonly block: IssueKeyBlock;
  /** The company's counter after the reservation; persisted in the same transaction. */
  readonly nextIssueNumber: number;
}

export function reserveIssueKeyBlock(
  nextIssueNumber: number,
  size: number = ISSUE_KEY_BLOCK_SIZE,
): IssueKeyReservation {
  const count = Math.max(1, Math.trunc(size));
  const blockStart = nextIssueNumber;
  const blockEnd = blockStart + count - 1;
  return { block: { blockStart, blockEnd }, nextIssueNumber: blockEnd + 1 };
}

export function issueKeyBlockSize(block: IssueKeyBlock): number {
  return block.blockEnd - block.blockStart + 1;
}

export function shouldReplenishIssueKeys(remaining: number): boolean {
  return remaining <= ISSUE_KEY_REPLENISH_THRESHOLD;
}

export function formatIssueKey(prefix: string, issueNumber: number): string {
  return `${prefix}-${issueNumber}`;
}

/** Import sets the counter above every preserved key so a restored company cannot collide. */
export function nextIssueNumberAbove(
  currentNextIssueNumber: number,
  highestExistingNumber: number,
): number {
  return Math.max(currentNextIssueNumber, highestExistingNumber + 1);
}
