// Guided macOS permission setup for Computer control: deep-links the exact
// System Settings pane and explains granting access to this installed build.

import type { DesktopComputerSettingsPane } from "@spiritdevs/contracts";

import { Button } from "../ui/button";

export const COMPUTER_PANE_LABELS: Readonly<Record<DesktopComputerSettingsPane, string>> = {
  accessibility: "Accessibility",
  "input-monitoring": "Input Monitoring",
  "screen-recording": "Screen Recording",
};

export function ComputerPermissionGuide(props: {
  readonly pane: DesktopComputerSettingsPane;
  readonly appDisplayName: string;
  readonly waiting: boolean;
  readonly onOpenSettings: () => void;
  readonly onRestart: () => void;
}) {
  const app = props.appDisplayName;
  const steps = [
    <Button
      key="open-settings"
      type="button"
      size="xs"
      variant="outline"
      onClick={props.onOpenSettings}
    >
      {`Open ${COMPUTER_PANE_LABELS[props.pane]} settings`}
    </Button>,
    `If this copy of ${app} is already listed, turn it on. Otherwise, drag the app from the floating guide into the list, or use + to choose this installed copy, then turn it on.`,
    "Complete any macOS authentication. If macOS asks you to quit and reopen, do so before checking again.",
  ];

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-4">
      <ol className="space-y-2.5">
        {steps.map((step, index) => (
          <li
            key={typeof step === "string" ? step : "open-settings"}
            className="flex items-start gap-2.5"
          >
            <span
              aria-hidden
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium text-muted-foreground"
            >
              {index + 1}
            </span>
            <span className="min-h-6 text-[13px] leading-6 text-muted-foreground">{step}</span>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 border-t border-border pt-3">
        {/* Static on purpose: the page polls while it waits, and an idle
            spinner would repaint the whole time. */}
        {props.waiting ? (
          <span className="text-xs text-muted-foreground">
            Watching for the change — this page updates automatically.
          </span>
        ) : (
          <span className="text-xs font-medium text-emerald-600">Permission granted.</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Still denied after an update or rebuild? Remove this app from the list and add this copy
        again. Complete any macOS authentication, and restart if macOS asks you to quit and reopen.
      </p>
      <Button type="button" size="xs" variant="outline" onClick={props.onRestart}>
        {`Restart ${app}`}
      </Button>
    </div>
  );
}
