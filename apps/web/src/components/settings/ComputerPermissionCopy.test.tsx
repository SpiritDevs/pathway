// The permissions copy: pane titles stay in sync with the grant labels, and the
// guide never claims a live system dialog is open.

import { COMPUTER_PERMISSION_LABELS } from "@spiritdevs/shared/computerGrants";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { ComputerPermissionGuide } from "./ComputerPermissionGuide";
import { COMPUTER_PERMISSION_PANES, ComputerHostPermissionNote } from "./ComputerPermissionSection";

function renderGuide(pane: Parameters<typeof ComputerPermissionGuide>[0]["pane"]) {
  return renderToStaticMarkup(
    <ComputerPermissionGuide
      pane={pane}
      appDisplayName="Pathway"
      waiting
      onOpenSettings={() => undefined}
      onRestart={() => undefined}
    />,
  );
}

const PANES = ["accessibility", "input-monitoring", "screen-recording"] as const;

describe("Computer permission copy", () => {
  it("keeps the pane titles equal to the grant labels", () => {
    const titles = COMPUTER_PERMISSION_PANES.map((entry) => entry.title).sort();
    const labels = Object.values(COMPUTER_PERMISSION_LABELS).sort();
    expect(titles).toEqual(labels);
  });

  it("walks through System Settings without claiming a live dialog", () => {
    for (const pane of PANES) {
      const markup = renderGuide(pane);
      expect(markup).toContain("Watching for the change");
      expect(markup).toContain("Restart");
      expect(markup).not.toContain("macOS is asking");
      expect(markup).not.toContain("live dialog");
      expect(markup).not.toContain("dialog is open");
      // Waiting is static text, never a repainting spinner.
      expect(markup).not.toContain("animate-");
    }
  });

  it("reuses drag or add instructions and makes authentication and stale-build recovery conditional", () => {
    for (const pane of PANES) {
      const markup = renderGuide(pane);
      expect(markup).toContain("drag the app from the floating guide");
      expect(markup).toContain("use + to choose this installed copy");
      expect(markup).toContain("If this copy of Pathway is already listed, turn it on.");
      expect(markup).toContain("If macOS asks you to quit and reopen");
      expect(markup).toContain("Remove this app from the list and add this copy");
      expect(markup).not.toContain("Entries cannot be dragged");
      expect(markup).not.toContain("No dialog will appear");
      expect(markup).not.toContain("Restarting the app clears");
    }
  });

  it("points a browser or remote environment at the host for grants", () => {
    const markup = renderToStaticMarkup(<ComputerHostPermissionNote />);
    expect(markup).toContain("Set up on the host");
    expect(markup).toContain("Pathway desktop app on that machine");
  });
});
