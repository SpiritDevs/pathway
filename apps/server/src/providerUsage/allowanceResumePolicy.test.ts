import { describe, expect, it } from "vite-plus/test";
import { RunId, type OrchestrationV2ThreadProjection } from "@spiritdevs/contracts";
import { canResumeAllowance } from "./allowanceResumePolicy.ts";
import { quotesAllowanceInstruction } from "@spiritdevs/contracts/providerAllowance";

const id = RunId.make("held-run");
const projection = () =>
  ({
    thread: { deletedAt: null, archivedAt: null, snoozedUntil: null },
    runs: [{ id, ordinal: 1, status: "interrupted", allowanceHold: "Allowance reached" }],
  }) as unknown as OrchestrationV2ThreadProjection;

describe("allowance continuation authority", () => {
  it("continues an allowance interruption but never an ordinary manual interruption", () => {
    const state = projection();
    expect(canResumeAllowance(state, id)).toBe(true);
    expect(
      canResumeAllowance({ ...state, runs: [{ ...state.runs[0]!, allowanceHold: null }] }, id),
    ).toBe(false);
  });
  it("drops a stale candidate after a newer user run, snooze, archive, or deletion", () => {
    const state = projection();
    expect(
      canResumeAllowance(
        {
          ...state,
          runs: [
            ...state.runs,
            { ...state.runs[0]!, id: RunId.make("new-user-request"), ordinal: 2, status: "queued" },
          ],
        },
        id,
      ),
    ).toBe(false);
    for (const key of ["archivedAt", "deletedAt", "snoozedUntil"] as const) {
      const changed = {
        ...state,
        thread: { ...state.thread, [key]: {} },
      } as OrchestrationV2ThreadProjection;
      expect(canResumeAllowance(changed, id)).toBe(false);
    }
  });
  it("requires the same numeric quota allocation in the quoted current instruction", () => {
    const source = "Use 10% of the usage allowance tonight.";
    expect(quotesAllowanceInstruction(source, source, 10)).toBe(true);
    expect(quotesAllowanceInstruction(source, source, 20)).toBe(false);
    expect(quotesAllowanceInstruction("Good morning", source, 10)).toBe(false);
    expect(quotesAllowanceInstruction("Use 10% of this file", "Use 10% of this file", 10)).toBe(
      false,
    );
    expect(quotesAllowanceInstruction("Use 0% of quota", "Use 0% of quota", 0)).toBe(false);
  });
});
