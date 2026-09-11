import { RunId } from "@spiritdevs/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  getAnchoredTurnMetrics,
  getRowBottom,
  keepTimelineEndVisibleAfterOverlayGrowth,
  scrollTimelineToEndIfFollowing,
  shouldAnchorTimelineActivity,
  type TimelineActivityObservation,
} from "./timelineScrollAnchoring";

const currentActivity: TimelineActivityObservation = {
  threadKey: "environment-a:thread-a",
  runId: RunId.make("current-run"),
  runStatus: "running",
  isLive: true,
};
const olderActivity: TimelineActivityObservation = {
  ...currentActivity,
  runId: RunId.make("older-run"),
  runStatus: "completed",
};

describe("timeline activity after opening a thread", () => {
  it("does not anchor cached history or the fresh history that replaces it", () => {
    const shell = { ...currentActivity, isLive: false };
    const cached = { ...olderActivity, isLive: false };
    const synchronizing = { ...currentActivity, isLive: false };

    expect(shouldAnchorTimelineActivity(shell, cached)).toBe(false);
    expect(shouldAnchorTimelineActivity(cached, synchronizing)).toBe(false);
    expect(shouldAnchorTimelineActivity(synchronizing, currentActivity)).toBe(false);
    expect(shouldAnchorTimelineActivity(currentActivity, currentActivity)).toBe(false);
  });

  it("does not anchor the first loaded run when the shell has no run", () => {
    expect(
      shouldAnchorTimelineActivity(
        { ...currentActivity, runId: null, runStatus: null, isLive: false },
        currentActivity,
      ),
    ).toBe(false);
  });

  it("does not treat reconnect catch-up as a newly started turn", () => {
    const reconnecting = { ...olderActivity, isLive: false };
    expect(shouldAnchorTimelineActivity(olderActivity, reconnecting)).toBe(false);
    expect(shouldAnchorTimelineActivity(reconnecting, currentActivity)).toBe(false);
  });

  it.each(["environment-a:thread-b", "environment-b:thread-a"])(
    "does not anchor a run on navigation to %s",
    (threadKey) => {
      expect(shouldAnchorTimelineActivity(olderActivity, { ...currentActivity, threadKey })).toBe(
        false,
      );
    },
  );

  it.each(["preparing", "starting", "running", "waiting"] as const)(
    "anchors new %s work after synchronization",
    (runStatus) => {
      expect(shouldAnchorTimelineActivity(olderActivity, { ...currentActivity, runStatus })).toBe(
        true,
      );
    },
  );

  it("anchors the first run started in an already loaded empty thread", () => {
    expect(
      shouldAnchorTimelineActivity(
        { ...currentActivity, runId: null, runStatus: null },
        currentActivity,
      ),
    ).toBe(true);
  });

  it("anchors a queued run when it starts, even though its run ID stays the same", () => {
    const queued = { ...currentActivity, runStatus: "queued" as const };
    expect(shouldAnchorTimelineActivity(olderActivity, queued)).toBe(false);
    expect(shouldAnchorTimelineActivity(queued, queued)).toBe(false);
    expect(shouldAnchorTimelineActivity(queued, currentActivity)).toBe(true);
  });

  it.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
    "does not anchor a historical %s run even when received live",
    (runStatus) => {
      expect(shouldAnchorTimelineActivity(currentActivity, { ...olderActivity, runStatus })).toBe(
        false,
      );
    },
  );
});

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("ignores a deferred end scroll after the user leaves live-follow mode", () => {
    const scrollToEnd = vi.fn();

    scrollTimelineToEndIfFollowing({
      timeline: { scrollToEnd },
      scrollMode: "free-scrolling",
      animated: true,
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("runs a deferred end scroll while live-follow is still active", () => {
    const scrollToEnd = vi.fn();

    scrollTimelineToEndIfFollowing({
      timeline: { scrollToEnd },
      scrollMode: "following-end",
      animated: true,
    });

    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });

  it("does not move a newly submitted prompt when history finishes loading", () => {
    const scrollToEnd = vi.fn();

    scrollTimelineToEndIfFollowing({
      timeline: { scrollToEnd },
      scrollMode: "anchoring-new-turn",
      animated: false,
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("lands at the newest messages without animation when history finishes loading", () => {
    const scrollToEnd = vi.fn();

    scrollTimelineToEndIfFollowing({
      timeline: { scrollToEnd },
      scrollMode: "following-end",
      animated: false,
    });

    expect(scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: false });
  });

  it("keeps the live edge visible when the composer overlay grows", () => {
    const scrollToEnd = vi.fn();

    keepTimelineEndVisibleAfterOverlayGrowth({
      timeline: { scrollToEnd },
      previousOverlayHeight: 120,
      overlayHeight: 180,
      followingEnd: true,
    });

    expect(scrollToEnd).toHaveBeenCalledOnce();
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("leaves the scroll position alone while the user reads history", () => {
    const scrollToEnd = vi.fn();

    keepTimelineEndVisibleAfterOverlayGrowth({
      timeline: { scrollToEnd },
      previousOverlayHeight: 120,
      overlayHeight: 180,
      followingEnd: false,
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("subtracts composer height from usable viewport height", () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutComposer?.overflowsUsableViewport).toBe(false);
    expect(withComposer?.overflowsUsableViewport).toBe(true);
  });
});
