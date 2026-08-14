import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewAutomationRevealTarget } from "./previewAutomationReveal";

describe("resolvePreviewAutomationRevealTarget", () => {
  describe("present", () => {
    it("prefers the open browser panel over the mini player", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "present",
          tabId: "tab-1",
          panelOpen: true,
          panelActiveSurfaceId: "diff",
          miniPlayerTabId: null,
        }),
      ).toBe("panel");
    });

    it("skips the panel when it already shows the automation tab", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "present",
          tabId: "tab-1",
          panelOpen: true,
          panelActiveSurfaceId: "browser:tab-1",
          miniPlayerTabId: null,
        }),
      ).toBeNull();
    });

    it("activates the automation tab when the panel shows a sibling tab", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "present",
          tabId: "tab-2",
          panelOpen: true,
          panelActiveSurfaceId: "browser:tab-1",
          miniPlayerTabId: null,
        }),
      ).toBe("panel");
    });

    it("falls back to the mini player when the panel is closed", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "present",
          tabId: "tab-1",
          panelOpen: false,
          panelActiveSurfaceId: null,
          miniPlayerTabId: null,
        }),
      ).toBe("mini-player");
    });

    it("skips the mini player when it already shows the automation tab", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "present",
          tabId: "tab-1",
          panelOpen: false,
          panelActiveSurfaceId: null,
          miniPlayerTabId: "tab-1",
        }),
      ).toBeNull();
    });
  });

  describe("follow", () => {
    it("retargets a browser panel watching a sibling tab", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "follow",
          tabId: "tab-2",
          panelOpen: true,
          panelActiveSurfaceId: "browser:tab-1",
          miniPlayerTabId: null,
        }),
      ).toBe("panel");
    });

    it("leaves a non-browser panel surface alone", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "follow",
          tabId: "tab-2",
          panelOpen: true,
          panelActiveSurfaceId: "diff",
          miniPlayerTabId: null,
        }),
      ).toBeNull();
    });

    it("repoints an open mini player at the automation tab", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "follow",
          tabId: "tab-2",
          panelOpen: false,
          panelActiveSurfaceId: null,
          miniPlayerTabId: "tab-1",
        }),
      ).toBe("mini-player");
    });

    it("never opens UI the user has closed", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "follow",
          tabId: "tab-1",
          panelOpen: false,
          panelActiveSurfaceId: null,
          miniPlayerTabId: null,
        }),
      ).toBeNull();
    });

    it("stays put when the watched surface already shows the tab", () => {
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "follow",
          tabId: "tab-1",
          panelOpen: true,
          panelActiveSurfaceId: "browser:tab-1",
          miniPlayerTabId: null,
        }),
      ).toBeNull();
      expect(
        resolvePreviewAutomationRevealTarget({
          mode: "follow",
          tabId: "tab-1",
          panelOpen: false,
          panelActiveSurfaceId: null,
          miniPlayerTabId: "tab-1",
        }),
      ).toBeNull();
    });
  });
});
