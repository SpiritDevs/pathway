import type { DeviceRemoteButton } from "@spiritdevs/contracts";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Pause, Tv, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import type { DeviceInputControls } from "./useDeviceInput";

/** On-screen Siri Remote. Presses are focus-engine button events, never touches. */
export function DeviceTvRemote(props: { readonly input: DeviceInputControls }) {
  const { queue, enabled } = props.input;
  const press = (button: DeviceRemoteButton) => queue.press({ kind: "remoteButton", button });
  const key = (button: DeviceRemoteButton, label: string, icon: ReactNode, className?: string) => (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={!enabled}
      className={className}
      onClick={() => press(button)}
    >
      {icon}
    </Button>
  );
  return (
    <div
      role="group"
      aria-label="Siri Remote"
      className="flex shrink-0 flex-wrap items-center justify-center gap-4 border-t px-3 py-2"
    >
      <div className="grid grid-cols-3 grid-rows-3 place-items-center rounded-full border border-border/60 bg-muted/40 p-1">
        {key("up", "Up", <ChevronUp />, "col-start-2")}
        {key("left", "Left", <ChevronLeft />, "col-start-1 row-start-2")}
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label="Select"
          title="Select"
          disabled={!enabled}
          className="col-start-2 row-start-2 rounded-full"
          onClick={() => press("select")}
        >
          <span aria-hidden className="size-2 rounded-full bg-current" />
        </Button>
        {key("right", "Right", <ChevronRight />, "col-start-3 row-start-2")}
        {key("down", "Down", <ChevronDown />, "col-start-2 row-start-3")}
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="flex gap-1">
          {key("back", "Back", <Undo2 />)}
          {key("home", "TV / Home", <Tv />)}
        </div>
        {key("playPause", "Play/Pause", <Pause />)}
      </div>
      <p className="max-w-48 text-xs text-muted-foreground">
        Click the screen, then use arrows, Enter, Esc, Space and Home.
      </p>
    </div>
  );
}
