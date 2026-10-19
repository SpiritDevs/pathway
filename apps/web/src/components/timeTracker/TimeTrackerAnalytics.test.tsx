import type {
  ActiveTrackedActivities,
  TrackedActivityOverview,
} from "@spiritdevs/contracts/businessTools";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConvexClient } from "convex/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const data = vi.hoisted(() => ({ overview: undefined as TrackedActivityOverview | undefined }));
vi.mock("../contacts/businessToolsCloud", () => ({
  useBusinessToolsQuery: () => ({ value: data.overview }),
}));
vi.mock("./useTimeTrackerClock", () => ({
  useTimeTrackerClock: () => Date.parse("2026-09-08T12:00:00Z"),
}));

import { TimeTrackerAnalytics } from "./TimeTrackerAnalytics";
import { TrackedActivityList } from "./TimeTrackerIndicator";

const totals = {
  workMs: 14_400_000,
  elapsedMs: 1_800_000,
  agentMs: 14_400_000,
  manualMs: 0,
  issueMs: 0,
};
const cloud = { client: {} as ConvexClient, accountID: "account", request: async () => null };

describe("time tracking analytics", () => {
  it("shows combined work separately from elapsed activity", () => {
    data.overview = {
      complete: true,
      totals,
      projects: [{ projectKey: "project", projectName: "Pathway", ...totals }],
      days: [{ date: "2026-09-08", ...totals }],
    };
    const markup = renderToStaticMarkup(<TimeTrackerAnalytics cloud={cloud} projects={[]} />);
    expect(markup).toContain("Combined work");
    expect(markup).toContain("4h 00m");
    expect(markup).toContain("Elapsed activity");
    expect(markup).toContain("30m");
    expect(markup).toContain('aria-label="Filter analytics by project"');
    expect(markup).toContain("Pathway");
  });

  it("does not present incomplete period aggregates as totals", () => {
    data.overview = { complete: false, totals, projects: [], days: [] };
    const markup = renderToStaticMarkup(<TimeTrackerAnalytics cloud={cloud} projects={[]} />);
    expect(markup).toContain("Choose a shorter period");
    expect(markup).not.toContain("4h 00m");
  });

  it("hides account totals when the authenticated client is unavailable", () => {
    data.overview = { complete: true, totals, projects: [], days: [] };
    const markup = renderToStaticMarkup(
      <TimeTrackerAnalytics cloud={{ ...cloud, client: null }} projects={[]} />,
    );
    expect(markup).not.toContain("4h 00m");
    expect(markup).toContain("Combined work");
  });

  it("keeps every concurrent session and its paused state visible", () => {
    const sessions: ActiveTrackedActivities["sessions"] = Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      description: `Agent ${index + 1}`,
      projectKey: "project",
      projectName: "Pathway",
      startedAt: "2026-09-08T00:00:00Z",
      stoppedAt: null,
      durationMs: 1_800_000,
      source: "agent",
      state: "paused",
      threadId: String(index),
      issueId: null,
      intervals: [],
      runningSince: null,
      observedAt: 0,
    }));
    const markup = renderToStaticMarkup(
      <TrackedActivityList sessions={sessions} now={1_000_000} />,
    );
    expect(markup.match(/Paused · waiting for input/g)).toHaveLength(8);
    expect(markup.match(/00:30:00/g)).toHaveLength(8);
    expect(markup).toContain("4h 00m");
    expect(markup).not.toContain("Stop timer");
  });
});
