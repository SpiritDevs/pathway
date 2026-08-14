import type {
  CommandId,
  OrchestrationV2BrowserTakeover,
  OrchestrationV2BrowserTakeoverFailure,
  OrchestrationV2BrowserTakeoverStatus,
  OrchestrationV2ThreadPreviewActivity,
  RunId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerBannerStack } from "./ComposerBannerStack";
import type {
  BrowserTakeoverBannerInput,
  BrowserTakeoverCalloutInput,
} from "./browserTakeoverBanner";
import {
  browserTakeoverBannerItem,
  browserTakeoverCalloutDismissKey,
  browserTakeoverFailureDismissKey,
  dismissBrowserTakeoverBannerForSession,
  isBrowserTakeoverBannerDismissedForSession,
  isBrowserTakeoverSettled,
  resolveBrowserTakeoverBanner,
  shouldShowBrowserTakeoverCallout,
} from "./browserTakeoverBanner";

const RUN_ID = "run-1" as RunId;
const HOST_CLIENT_ID = "host-client-1";
const NOW = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const activity = (
  overrides: Partial<OrchestrationV2ThreadPreviewActivity> = {},
): OrchestrationV2ThreadPreviewActivity => ({
  runId: RUN_ID,
  providerSessionId: "session-1",
  tabId: "tab-1",
  hostClientId: HOST_CLIENT_ID,
  lastActivityAt: NOW,
  ...overrides,
});

const eligible = {
  previewActivity: activity(),
  takeoverStatus: null,
  activeRunId: RUN_ID,
  activeRunStatus: "running",
  previewSupported: true,
  automationHostClientId: HOST_CLIENT_ID,
  dismissed: false,
} as const satisfies BrowserTakeoverCalloutInput;

const takeover = (
  overrides: Partial<OrchestrationV2BrowserTakeover> = {},
): OrchestrationV2BrowserTakeover => ({
  id: "takeover-1" as CommandId,
  status: "active",
  runId: RUN_ID,
  providerSessionId: "session-1",
  tabId: "tab-1",
  hostClientId: HOST_CLIENT_ID,
  hostConnectionId: "connection-1",
  failure: null,
  requestedAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const bannerInput = {
  threadKey: "env:thread-1",
  takeover: null,
  previewActivity: activity(),
  activeRunId: RUN_ID,
  activeRunStatus: "running",
  previewSupported: true,
  automationHostClientId: HOST_CLIENT_ID,
  requestPending: false,
  isDismissed: () => false,
} as const satisfies BrowserTakeoverBannerInput;

const bannerFor = (
  status: OrchestrationV2BrowserTakeoverStatus,
  overrides: Partial<OrchestrationV2BrowserTakeover> = {},
  inputOverrides: Partial<BrowserTakeoverBannerInput> = {},
) =>
  resolveBrowserTakeoverBanner({
    ...bannerInput,
    takeover: takeover({ status, ...overrides }),
    ...inputOverrides,
  });

const failureBanner = (failure: OrchestrationV2BrowserTakeoverFailure) =>
  bannerFor("failed", { failure });

describe("shouldShowBrowserTakeoverCallout", () => {
  it("invites the hosting desktop while the browsing run is still active", () => {
    expect(shouldShowBrowserTakeoverCallout(eligible)).toBe(true);
  });

  it("hides when there is no preview activity to assist", () => {
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, previewActivity: null })).toBe(false);
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, previewActivity: undefined })).toBe(
      false,
    );
  });

  it("hides when the activity belongs to a run that already finished", () => {
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, activeRunId: null })).toBe(false);
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, activeRunId: "run-2" as RunId })).toBe(
      false,
    );
    expect(
      shouldShowBrowserTakeoverCallout({
        ...eligible,
        previewActivity: activity({ runId: null }),
      }),
    ).toBe(false);
  });

  it("only offers a takeover while the run can still be paused", () => {
    for (const status of ["preparing", "starting", "running"] as const) {
      expect(shouldShowBrowserTakeoverCallout({ ...eligible, activeRunStatus: status })).toBe(true);
    }
    // "waiting" is post-turn drain: the sidebar still calls the run active, but
    // the server has no agent turn left to interrupt and rejects the request.
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, activeRunStatus: "waiting" })).toBe(
      false,
    );
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, activeRunStatus: null })).toBe(false);
  });

  it("hides on clients that cannot host the browser", () => {
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, previewSupported: false })).toBe(false);
  });

  it("hides on a desktop that does not own this thread's browser", () => {
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, automationHostClientId: null })).toBe(
      false,
    );
    expect(
      shouldShowBrowserTakeoverCallout({ ...eligible, automationHostClientId: "other-desktop" }),
    ).toBe(false);
  });

  it("hides while a takeover already owns the browser, including a failed one", () => {
    for (const status of ["requested", "pausing", "active", "proceeding", "failed"] as const) {
      expect(shouldShowBrowserTakeoverCallout({ ...eligible, takeoverStatus: status })).toBe(false);
    }
    for (const status of ["completed", "cancelled"] as const) {
      expect(shouldShowBrowserTakeoverCallout({ ...eligible, takeoverStatus: status })).toBe(true);
    }
  });

  it("hides once dismissed", () => {
    expect(shouldShowBrowserTakeoverCallout({ ...eligible, dismissed: true })).toBe(false);
  });
});

describe("browser takeover session dismissal", () => {
  it("scopes a dismissal to the run it was made for", () => {
    const runKey = browserTakeoverCalloutDismissKey("env:thread-1", RUN_ID);
    dismissBrowserTakeoverBannerForSession(runKey);

    expect(isBrowserTakeoverBannerDismissedForSession(runKey)).toBe(true);
    expect(
      isBrowserTakeoverBannerDismissedForSession(
        browserTakeoverCalloutDismissKey("env:thread-1", "run-2" as RunId),
      ),
    ).toBe(false);
    expect(
      isBrowserTakeoverBannerDismissedForSession(
        browserTakeoverCalloutDismissKey("env:other-thread", RUN_ID),
      ),
    ).toBe(false);
    expect(isBrowserTakeoverBannerDismissedForSession(null)).toBe(false);
  });

  it("never collides a callout key with a failure key", () => {
    expect(browserTakeoverCalloutDismissKey("env:thread-1", RUN_ID)).not.toBe(
      browserTakeoverFailureDismissKey("env:thread-1", RUN_ID as string as CommandId),
    );
    expect(browserTakeoverCalloutDismissKey(null, RUN_ID)).toBeNull();
    expect(browserTakeoverFailureDismissKey(null, "takeover-1" as CommandId)).toBeNull();
  });
});

describe("isBrowserTakeoverSettled", () => {
  it("treats only completed and cancelled as done", () => {
    expect(isBrowserTakeoverSettled("completed")).toBe(true);
    expect(isBrowserTakeoverSettled("cancelled")).toBe(true);
    expect(isBrowserTakeoverSettled("failed")).toBe(false);
    expect(isBrowserTakeoverSettled(null)).toBe(false);
    expect(isBrowserTakeoverSettled(undefined)).toBe(false);
  });
});

describe("resolveBrowserTakeoverBanner", () => {
  it("offers the callout with a busy label while a request is in flight", () => {
    const idle = resolveBrowserTakeoverBanner({
      ...bannerInput,
      threadKey: "env:thread-callout",
    });
    expect(idle?.tone).toBe("callout");
    expect(idle?.title).toBe("Take over to assist agent");
    expect(idle?.actions.map((action) => action.kind)).toEqual(["take-over"]);
    expect(idle?.actions[0]?.busy).toBe(false);
    expect(idle?.dismissKey).not.toBeNull();

    const pending = resolveBrowserTakeoverBanner({
      ...bannerInput,
      threadKey: "env:thread-callout",
      requestPending: true,
    });
    expect(pending?.actions[0]?.busy).toBe(true);
    expect(pending?.actions[0]?.label).toBe("Taking over...");
  });

  it("renders nothing without a takeover and without an eligible callout", () => {
    expect(
      resolveBrowserTakeoverBanner({
        ...bannerInput,
        previewActivity: null,
      }),
    ).toBeNull();
  });

  it("stops rendering a settled takeover, and can invite a fresh one", () => {
    for (const status of ["completed", "cancelled"] as const) {
      // Nothing to assist: the settled takeover leaves no banner behind.
      expect(
        resolveBrowserTakeoverBanner({
          ...bannerInput,
          previewActivity: null,
          takeover: takeover({ status }),
        }),
      ).toBeNull();
      // The agent went back to the browser on a still-active run: offer again.
      expect(bannerFor(status)?.tone).toBe("callout");
    }
  });

  it("keeps an escape hatch while pausing, and none while resuming", () => {
    for (const status of ["requested", "pausing"] as const) {
      const banner = bannerFor(status);
      expect(banner?.title).toBe("Pausing agent...");
      // Draining a wedged provider can hold this state for over a minute, so
      // the user always keeps a way out. Proceed stays absent: there is
      // nothing to proceed to until the agent has actually stopped.
      expect(banner?.actions.map((action) => action.kind)).toEqual(["release"]);
      expect(banner?.actions[0]?.label).toBe("End takeover");
      expect(banner?.actions[0]?.emphasis).toBe("secondary");
      expect(banner?.transient).toBe(true);
      expect(banner?.dismissKey).toBeNull();
    }
    const proceeding = bannerFor("proceeding");
    expect(proceeding?.title).toBe("Resuming agent...");
    expect(proceeding?.actions).toEqual([]);
    expect(proceeding?.transient).toBe(true);
  });

  it("gives the owning desktop control and points other clients at it", () => {
    const owning = bannerFor("active");
    expect(owning?.title).toBe("Agent paused — you have control");
    expect(owning?.actions.map((action) => action.kind)).toEqual(["proceed", "release"]);
    expect(owning?.actions.map((action) => action.label)).toEqual(["Proceed", "End takeover"]);

    const other = bannerFor("active", {}, { automationHostClientId: "other-desktop" });
    expect(other?.title).toBe(
      "Agent paused — the browser is under manual control on another Pathway desktop",
    );
    // Proceed/release are server commands any client may issue; only the
    // "you have control" claim is reserved for the owning desktop.
    expect(other?.actions.map((action) => action.kind)).toEqual(["proceed", "release"]);
  });

  it("offers retry plus end for a failed continuation", () => {
    const banner = failureBanner("continuation_failed");
    expect(banner?.tone).toBe("failed");
    expect(banner?.title).toBe("Couldn't resume the agent");
    expect(banner?.actions.map((action) => action.label)).toEqual(["Retry", "End takeover"]);
  });

  it("offers a lease release for every failure that can strand the browser", () => {
    for (const failure of [
      "no_live_host",
      "host_disconnected",
      "fence_failed",
      "interrupt_failed",
      "server_restarted",
    ] as const) {
      const banner = failureBanner(failure);
      expect(banner?.tone).toBe("failed");
      expect(banner?.actions.map((action) => action.kind)).toEqual(["release"]);
      expect(banner?.actions[0]?.label).toBe("Release browser lease");
      expect(banner?.dismissKey).toBeNull();
    }
  });

  it("only informs (and can be dismissed) when the agent already finished", () => {
    const banner = failureBanner("already_finished");
    expect(banner?.tone).toBe("finished");
    expect(banner?.title).toBe("The agent already finished");
    expect(banner?.actions).toEqual([]);
    expect(banner?.dismissKey).not.toBeNull();

    const dismissed = resolveBrowserTakeoverBanner({
      ...bannerInput,
      takeover: takeover({ status: "failed", failure: "already_finished" }),
      isDismissed: () => true,
    });
    expect(dismissed).toBeNull();
  });

  it("renders nothing when the projected thread predates browser takeover", () => {
    expect(
      resolveBrowserTakeoverBanner({
        threadKey: "env:thread-old",
        takeover: undefined,
        previewActivity: undefined,
        activeRunId: RUN_ID,
        activeRunStatus: "running",
        previewSupported: true,
        automationHostClientId: HOST_CLIENT_ID,
        requestPending: false,
        isDismissed: () => false,
      }),
    ).toBeNull();
  });
});

describe("browserTakeoverBannerItem", () => {
  it("renders the callout with a keyboard-reachable action and a dismiss control", () => {
    const descriptor = resolveBrowserTakeoverBanner({
      ...bannerInput,
      threadKey: "env:thread-markup",
    });
    if (descriptor === null) throw new Error("expected a callout descriptor");

    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          browserTakeoverBannerItem(descriptor, {
            onTakeOver: () => {},
            onProceed: () => {},
            onRelease: () => {},
            onDismiss: () => {},
          }),
        ]}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Take over to assist agent");
    expect(markup).toContain("Take over</button>");
    expect(markup).toContain('aria-label="Dismiss browser takeover offer"');
    expect(markup).not.toContain('role="status"');
  });

  it("wraps a transient status in a polite live region, keeping only the escape hatch", () => {
    const descriptor = bannerFor("pausing");
    if (descriptor === null) throw new Error("expected a pausing descriptor");

    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          browserTakeoverBannerItem(descriptor, {
            onTakeOver: () => {},
            onProceed: () => {},
            onRelease: () => {},
            onDismiss: () => {},
          }),
        ]}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Pausing agent...");
    expect(markup).toContain("End takeover</button>");
    expect(markup).not.toContain("Proceed</button>");
  });
});
