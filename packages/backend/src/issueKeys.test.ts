import { describe, expect, it } from "vite-plus/test";

import {
  formatIssueKey,
  ISSUE_KEY_BLOCK_SIZE,
  issueKeyBlockSize,
  nextIssueNumberAbove,
  reserveIssueKeyBlock,
  shouldReplenishIssueKeys,
} from "./issueKeys.ts";

describe("reserveIssueKeyBlock", () => {
  it("leases twenty-five numbers by default", () => {
    const reservation = reserveIssueKeyBlock(1);

    expect(reservation.block).toEqual({ blockStart: 1, blockEnd: 25 });
    expect(issueKeyBlockSize(reservation.block)).toBe(ISSUE_KEY_BLOCK_SIZE);
    expect(reservation.nextIssueNumber).toBe(26);
  });

  it("never hands the same number to two clients", () => {
    const first = reserveIssueKeyBlock(1);
    const second = reserveIssueKeyBlock(first.nextIssueNumber);

    expect(second.block.blockStart).toBe(first.block.blockEnd + 1);
    expect(second.block.blockStart).toBeGreaterThan(first.block.blockEnd);
  });

  it("leaves a gap rather than recycling an unspent block", () => {
    const abandoned = reserveIssueKeyBlock(1);
    // The holder of `abandoned` disappears having spent only its first number.
    const next = reserveIssueKeyBlock(abandoned.nextIssueNumber);

    expect(next.block.blockStart).toBe(26);
  });
});

describe("shouldReplenishIssueKeys", () => {
  it("asks for the next block once five numbers remain", () => {
    expect(shouldReplenishIssueKeys(6)).toBe(false);
    expect(shouldReplenishIssueKeys(5)).toBe(true);
    expect(shouldReplenishIssueKeys(0)).toBe(true);
  });
});

describe("formatIssueKey", () => {
  it("joins the company prefix and the leased number", () => {
    expect(formatIssueKey("PW", 42)).toBe("PW-42");
  });
});

describe("nextIssueNumberAbove", () => {
  it("moves the counter above every preserved key on import", () => {
    expect(nextIssueNumberAbove(1, 317)).toBe(318);
    expect(nextIssueNumberAbove(400, 317)).toBe(400);
  });
});
