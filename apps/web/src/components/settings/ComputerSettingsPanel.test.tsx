// What the Computer settings surface tells the user about the desktop backend:
// the one attention row, the calm ready state, and the chrome it must not grow
// back. Rendered to static markup, which is enough: it is a read-out decided at
// render time. Pressing Set up belongs to the provision hook.

import {
  ComputerId,
  DEFAULT_CLIENT_SETTINGS,
  type ComputerStatusResult,
} from "@spiritdevs/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { ComputerHostPermissionNote } from "./ComputerPermissionSection";
import { ComputerSettingsView, type ComputerSettingsViewSettings } from "./ComputerSettingsPanel";
import { resolveComputerSettingsAttention } from "./ComputerSettingsPanel.logic";

function capabilities(overrides: Partial<ComputerStatusResult["capabilities"]> = {}) {
  return {
    windows: true,
    windowBounds: true,
    stacking: true,
    capture: true,
    input: true,
    clipboard: true,
    focus: true,
    raise: true,
    ghostCursor: true,
    visibleDesktop: true,
    ...overrides,
  };
}

function status(overrides: Partial<ComputerStatusResult> = {}): ComputerStatusResult {
  return {
    computerId: ComputerId.make("desktop"),
    availability: { kind: "available", backend: "mac" },
    capabilities: capabilities(),
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    ...overrides,
  };
}

function render(
  input: {
    readonly status?: ComputerStatusResult;
    readonly statusError?: string;
    readonly settings?: Partial<ComputerSettingsViewSettings>;
    readonly setup?: { readonly isPending: boolean; readonly note: string | undefined };
    readonly permissions?: ReactNode;
  } = {},
) {
  const attention = resolveComputerSettingsAttention({
    status: input.status,
    statusError: input.statusError ?? null,
    nativeState: null,
    hasNativeBridge: false,
  });
  return renderToStaticMarkup(
    <ComputerSettingsView
      settings={{ ...DEFAULT_CLIENT_SETTINGS, computerControlEnabled: true, ...input.settings }}
      updateSettings={vi.fn()}
      status={input.status}
      attention={attention}
      setup={{ provision: vi.fn(), isPending: false, note: undefined, ...input.setup }}
      retry={{ isChecking: false, onRetry: vi.fn() }}
      permissions={input.permissions ?? null}
    />,
  );
}

describe("ComputerSettingsView", () => {
  it("opens as one Computer control surface with the toggle in the header", () => {
    const markup = render({ status: status() });
    expect(markup.match(/Computer control/g) ?? []).toHaveLength(1);
    expect(markup).toContain("Enable Computer by default in any chat.");
    expect(markup).toContain("use /computer-use for one request");
    expect(markup).toContain('aria-label="Let the agent use the desktop in any chat"');
    // The section is the search/deep-link target for the toggle it carries.
    expect(markup).toContain('id="computer-control"');
  });

  it("keeps the surface calm while the desktop is ready", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("Connected to the desktop");
    expect(markup).not.toContain("Set up");
    expect(markup).not.toContain("Refresh");
    expect(markup).not.toContain("Desktop backend");
    expect(markup).not.toContain("Capabilities");
  });

  it("asks to check access while nothing has confirmed the grants", () => {
    const markup = render({
      status: status({
        health: {
          status: "unavailable",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: false,
        },
      }),
    });
    expect(markup).toContain("Computer access has not been checked");
    expect(markup).toContain("Set up");
  });

  it("names the withheld grants once and offers Set up", () => {
    const markup = render({
      status: status({
        availability: {
          kind: "permission-required",
          missing: ["accessibility", "screenRecording"],
          message: "macOS is asking for Accessibility.",
          buildSignature: "adhoc",
        },
      }),
    });
    expect(markup).toContain("Computer control needs Accessibility and Screen Recording");
    expect(markup).toContain("macOS is asking for Accessibility.");
    expect(markup).toContain("Set up");
    expect(markup.match(/Computer control needs/g) ?? []).toHaveLength(1);
    expect(markup).not.toContain("not allowed yet");
  });

  it("keeps the blind-desktop copy honest and fixable", () => {
    const markup = render({
      status: status({
        health: {
          status: "connected",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: false,
        },
      }),
    });
    expect(markup).toContain("Screen capture is not allowed yet");
    expect(markup).toContain("Screen Recording");
    expect(markup).toContain("cannot see it");
    expect(markup).toContain("Set up");
    // A blind desktop never gets an abilities read-out that claims capture.
    expect(markup).not.toContain("screen capture");
    // Names the grant without claiming a live system dialog.
    expect(markup).not.toContain("macOS is asking");
    expect(markup).not.toContain("live dialog");
    expect(markup).not.toContain("dialog is open");
  });

  it("reports a reconnect in flight without offering a manual re-arm", () => {
    const markup = render({
      status: status({
        health: {
          status: "reconnecting",
          consecutiveFailures: 1,
          reconnects: 1,
          captureAvailable: true,
        },
      }),
    });
    expect(markup).toContain("Reconnecting to the desktop");
    expect(markup).toContain("Reconnected once since startup.");
    // The checking tone is a static dot, never a repainting pulse.
    expect(markup).not.toContain("animate-pulse");
  });

  it("never renders the retired Escape-stop chrome", () => {
    for (const input of [{ status: status({ inputStopped: true }) }, { status: status() }]) {
      const markup = render(input);
      expect(markup).not.toContain("Input stopped");
      expect(markup).not.toContain("Re-arm input");
    }
  });

  it("combines the automatic preview and its size into one row", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("Preview");
    expect(markup).toContain("Compact");
    expect(markup).toContain("Large");
    expect(markup).toContain(
      'aria-label="Show the computer preview automatically when an agent drives the desktop"',
    );
    expect(markup).toContain('aria-label="In-chat computer preview size"');
    expect(markup).not.toContain("Computer preview");
    expect(markup).not.toContain("Preview size");
  });

  it("offers the preview row on a backend that drives its own seat too", () => {
    const markup = render({
      status: status({
        availability: { kind: "available", backend: "nested-kwin" },
        capabilities: capabilities({ visibleDesktop: false }),
      }),
    });
    expect(markup).toContain("Preview");
    expect(markup).toContain("Compact");
  });

  it("describes observation-only Cua without promising Mac input", () => {
    const markup = render({
      status: status({
        availability: { kind: "available", backend: "cua" },
        capabilities: capabilities({
          input: false,
          focus: false,
          raise: false,
          ghostCursor: false,
        }),
      }),
    });
    expect(markup).toContain("Cua 0.28.2");
    expect(markup).toContain("native desktop input is unavailable");
    expect(markup).toContain("verified browser runtime");
    expect(markup).not.toContain("shares your Mac");
    expect(markup).not.toContain("macOS desktop");
  });

  it("keeps the details collapsed until asked for", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("Advanced");
    expect(markup).toContain('aria-expanded="false"');
    // Mounted but hidden, so an open permission guide keeps its state.
    expect(markup).toContain("hidden");
    expect(markup).toContain("Desktop abilities");
    expect(markup).toContain("macOS desktop");
  });

  it("offers Check again when the status could not be read", () => {
    const markup = render({ statusError: "Socket closed." });
    expect(markup).toContain("Computer status is unavailable");
    expect(markup).toContain("Socket closed.");
    expect(markup).toContain("Check again");
    expect(markup).not.toContain("Set up");
  });

  it("keeps the provision account inline while Set up runs", () => {
    const markup = render({
      status: status({
        availability: {
          kind: "permission-required",
          missing: ["accessibility"],
          message: "Allow Accessibility.",
          buildSignature: "adhoc",
        },
      }),
      setup: { isPending: true, note: "Checking Accessibility." },
    });
    expect(markup).toContain("Setting up…");
    expect(markup).toContain("Checking Accessibility.");
  });

  it("says where grants are set up when this client cannot grant them", () => {
    const markup = render({ status: status(), permissions: <ComputerHostPermissionNote /> });
    expect(markup).toContain("Set up on the host");
    expect(markup).toContain("belong to the machine running this environment");
  });

  describe("agent cursor colors", () => {
    it("keeps the cursor stock by default and hides the color editors", () => {
      const markup = render({ status: status() });
      expect(markup).toContain("Cursor colors");
      expect(markup).toContain("Stock");
      expect(markup).toContain("Custom");
      expect(markup).not.toContain("Fill color");
      expect(markup).not.toContain("Rim color");
      expect(markup).not.toContain("data-swatch");
    });

    it("reveals fill and rim editors, with swatches, after Custom is chosen", () => {
      const markup = render({
        status: status(),
        settings: {
          agentCursorColorMode: "custom",
          agentCursorFillColor: "#aabbcc",
          agentCursorRimColor: "#112233",
        },
      });
      expect(markup).toContain("Fill color");
      expect(markup).toContain("Rim color");
      expect(markup).toContain('value="#aabbcc"');
      expect(markup).toContain('value="#112233"');
      expect(markup).toContain("background-color:#aabbcc");
      expect(markup).toContain("background-color:#112233");
    });
  });
});
