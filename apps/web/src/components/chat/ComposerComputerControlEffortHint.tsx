import { MonitorIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import {
  COMPUTER_CONTROL_HINT_ACTION_LABEL,
  COMPUTER_CONTROL_HINT_MESSAGE,
} from "./composerComputerControlHint";

/**
 * One-line strip atop the composer suggesting Medium effort while a chat drives
 * the desktop, with one-click apply and a permanent dismiss. It mounts and
 * unmounts rather than animating, so the composer never reserves its space.
 */
export const ComposerComputerControlEffortHint = memo(function ComposerComputerControlEffortHint({
  onApply,
  onDismiss,
}: {
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2 sm:px-5"
      data-testid="composer-computer-control-effort-hint"
    >
      <MonitorIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {COMPUTER_CONTROL_HINT_MESSAGE}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="xs" variant="outline" onClick={onApply}>
          {COMPUTER_CONTROL_HINT_ACTION_LABEL}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Dismiss tip"
          title="Dismiss tip"
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
});
