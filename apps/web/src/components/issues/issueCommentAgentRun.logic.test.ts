import { IssueCommentId, type IssueCommentAgentRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatIssueCommentAgentRunDuration,
  hasIssueCommentAgentRunDetails,
  issueCommentAgentRunDurationMs,
  issueCommentAgentRunPresentation,
} from "./issueCommentAgentRun.logic";

type RunFacts = Pick<
  IssueCommentAgentRun,
  "state" | "phase" | "error" | "replyCommentId" | "startedAt" | "finishedAt"
>;

function run(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    state: "queued",
    phase: null,
    error: null,
    replyCommentId: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("issueCommentAgentRunPresentation", () => {
  it("says a queued run has not started, and offers only cancel", () => {
    const presentation = issueCommentAgentRunPresentation(run());

    expect(presentation.label).toBe("Waiting to start");
    expect(presentation.tone).toBe("pending");
    expect(presentation.isActive).toBe(true);
    expect(presentation.canCancel).toBe(true);
    expect(presentation.canRetry).toBe(false);
  });

  it("prints the phase the engine reported", () => {
    expect(
      issueCommentAgentRunPresentation(run({ state: "running", phase: "thinking" })).label,
    ).toBe("Thinking…");
    expect(
      issueCommentAgentRunPresentation(run({ state: "running", phase: "researching" })).label,
    ).toBe("Researching the project…");
    expect(
      issueCommentAgentRunPresentation(run({ state: "running", phase: "replying" })).label,
    ).toBe("Writing reply…");
  });

  it("reads a phaseless running run as working rather than idle", () => {
    const presentation = issueCommentAgentRunPresentation(run({ state: "running", phase: null }));

    expect(presentation.label).toBe("Working…");
    expect(presentation.tone).toBe("active");
    expect(presentation.canCancel).toBe(true);
  });

  it("says it replied only when there is a reply to read", () => {
    expect(
      issueCommentAgentRunPresentation(
        run({ state: "completed", replyCommentId: IssueCommentId.make("c1") }),
      ).label,
    ).toBe("Replied");
    expect(issueCommentAgentRunPresentation(run({ state: "completed" })).label).toBe("Finished");
  });

  it("offers retry, not cancel, once a run is terminal and unsuccessful", () => {
    const failed = issueCommentAgentRunPresentation(run({ state: "failed", error: "boom" }));
    const canceled = issueCommentAgentRunPresentation(run({ state: "canceled" }));
    const completed = issueCommentAgentRunPresentation(run({ state: "completed" }));

    expect([failed.canRetry, canceled.canRetry, completed.canRetry]).toEqual([true, true, false]);
    expect([failed.canCancel, canceled.canCancel, completed.canCancel]).toEqual([
      false,
      false,
      false,
    ]);
    expect([failed.isActive, canceled.isActive]).toEqual([false, false]);
    expect(failed.label).toBe("Failed");
    expect(canceled.label).toBe("Canceled");
  });

  it("shows the failure text, and a fallback when the writer left none", () => {
    expect(
      issueCommentAgentRunPresentation(run({ state: "failed", error: " boom " })).errorText,
    ).toBe("boom");
    expect(issueCommentAgentRunPresentation(run({ state: "failed", error: "   " })).errorText).toBe(
      "The agent run failed.",
    );
    expect(issueCommentAgentRunPresentation(run({ state: "failed", error: null })).errorText).toBe(
      "The agent run failed.",
    );
  });

  it("keeps an error off every state that is not a failure", () => {
    // A cancel is a decision, not a fault, so it never reads as one even if a message was written.
    expect(
      issueCommentAgentRunPresentation(run({ state: "canceled", error: "aborted" })).errorText,
    ).toBeNull();
    expect(issueCommentAgentRunPresentation(run({ state: "running" })).errorText).toBeNull();
  });

  it("prints a duration on a completed run only", () => {
    const timing = {
      startedAt: "2026-08-13T00:00:00.000Z",
      finishedAt: "2026-08-13T00:00:04.000Z",
    } as const;

    expect(
      issueCommentAgentRunPresentation(run({ state: "completed", ...timing })).durationLabel,
    ).toBe("4s");
    expect(
      issueCommentAgentRunPresentation(run({ state: "failed", ...timing })).durationLabel,
    ).toBeNull();
    expect(issueCommentAgentRunPresentation(run({ state: "completed" })).durationLabel).toBeNull();
  });
});

describe("issueCommentAgentRunDurationMs", () => {
  it("measures the span between the two ends", () => {
    expect(
      issueCommentAgentRunDurationMs({
        startedAt: "2026-08-13T00:00:00.000Z",
        finishedAt: "2026-08-13T00:01:00.000Z",
      }),
    ).toBe(60_000);
  });

  it("refuses a half-open, unparseable, or backwards span", () => {
    expect(
      issueCommentAgentRunDurationMs({ startedAt: "2026-08-13T00:00:00.000Z", finishedAt: null }),
    ).toBeNull();
    expect(
      issueCommentAgentRunDurationMs({ startedAt: null, finishedAt: "2026-08-13T00:00:00.000Z" }),
    ).toBeNull();
    expect(
      issueCommentAgentRunDurationMs({
        startedAt: "not a date",
        finishedAt: "2026-08-13T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      issueCommentAgentRunDurationMs({
        startedAt: "2026-08-13T00:00:10.000Z",
        finishedAt: "2026-08-13T00:00:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("formatIssueCommentAgentRunDuration", () => {
  it("grows a unit at a time and pads the smaller one", () => {
    expect(formatIssueCommentAgentRunDuration(0)).toBe("0s");
    expect(formatIssueCommentAgentRunDuration(4_400)).toBe("4s");
    expect(formatIssueCommentAgentRunDuration(59_999)).toBe("59s");
    expect(formatIssueCommentAgentRunDuration(60_000)).toBe("1m 00s");
    expect(formatIssueCommentAgentRunDuration(80_000)).toBe("1m 20s");
    expect(formatIssueCommentAgentRunDuration(3_600_000)).toBe("1h 00m");
    expect(formatIssueCommentAgentRunDuration(3_840_000)).toBe("1h 04m");
  });

  it("floors a negative span at zero rather than printing a minus", () => {
    expect(formatIssueCommentAgentRunDuration(-5_000)).toBe("0s");
  });
});

describe("hasIssueCommentAgentRunDetails", () => {
  it("earns the disclosure only once there is something behind it", () => {
    expect(hasIssueCommentAgentRunDetails({ transcript: "" })).toBe(false);
    expect(hasIssueCommentAgentRunDetails({ transcript: "  \n " })).toBe(false);
    expect(hasIssueCommentAgentRunDetails({ transcript: "read src/app.ts" })).toBe(true);
  });
});
