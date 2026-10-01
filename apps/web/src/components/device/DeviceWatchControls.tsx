import { ChevronDown, ChevronUp, Circle, RectangleVertical } from "lucide-react";
import { Button } from "~/components/ui/button";
import { crownDeltaFromWheel } from "./deviceFamily";
import type { DeviceInputControls } from "./useDeviceInput";

/** One step of the Crown buttons or arrow keys, in SimulatorKit wheel pixels. */
export const CROWN_STEP = 40;

/** Digital Crown rail and side button. The wheel over the screen turns the Crown too. */
export function DeviceWatchControls(props: { readonly input: DeviceInputControls }) {
  const { queue, enabled } = props.input;
  return (
    <div
      role="group"
      aria-label="Digital Crown"
      className="flex flex-col items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      tabIndex={enabled ? 0 : -1}
      onWheel={(event) => {
        if (enabled && !event.ctrlKey) queue.turnCrown(crownDeltaFromWheel(event));
      }}
      onKeyDown={(event) => {
        if (!enabled || event.target !== event.currentTarget) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        queue.turnCrown(event.key === "ArrowUp" ? -CROWN_STEP : CROWN_STEP);
      }}
    >
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Turn Digital Crown up"
        title="Turn Digital Crown up"
        disabled={!enabled}
        onClick={() => queue.turnCrown(-CROWN_STEP)}
      >
        <ChevronUp />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Press Digital Crown"
        title="Press Digital Crown"
        disabled={!enabled}
        onClick={() => queue.press({ kind: "watchButton", button: "crown" })}
      >
        <Circle />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Turn Digital Crown down"
        title="Turn Digital Crown down"
        disabled={!enabled}
        onClick={() => queue.turnCrown(CROWN_STEP)}
      >
        <ChevronDown />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Press side button"
        title="Press side button"
        disabled={!enabled}
        onClick={() => queue.press({ kind: "watchButton", button: "side" })}
      >
        <RectangleVertical />
      </Button>
    </div>
  );
}
