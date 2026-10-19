import { Schema } from "effect";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const STORAGE_KEY = "pathway:computer-getting-started:v1";

/** Introduce Computer where it is enabled, without opening another startup dialog. */
export function ComputerGettingStarted({
  snapShotAvailable,
}: {
  /** The desktop app hosts SnapShot, so the guide says how the two differ. */
  readonly snapShotAvailable: boolean;
}) {
  const [acknowledged, setAcknowledged] = useLocalStorage(STORAGE_KEY, false, Schema.Boolean);
  const [requestedOpen, setRequestedOpen] = useState(false);
  const open = !acknowledged || requestedOpen;
  const dismiss = () => {
    setRequestedOpen(false);
    if (!acknowledged) setAcknowledged(true);
  };

  return (
    <SettingsSection
      title="Getting started"
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          onClick={() => (open ? dismiss() : setRequestedOpen(true))}
        >
          <ChevronDownIcon className={cn("size-3.5", open && "rotate-180")} aria-hidden />
          {open ? "Hide guide" : "Show guide"}
        </Button>
      }
    >
      {open ? (
        <>
          <SettingsRow
            title="Ask for a task"
            description="Type /computer-use followed by your task, for example: “/computer-use open Calculator and calculate 123 × 45.” This enables Computer for that request only. The default setting below can enable it on every turn."
          />
          <SettingsRow
            title="Approve the task"
            description="If asked, approve Computer for the task. Use the permission guide when desktop access is missing. Pathway may still ask before consequential actions."
          />
          <SettingsRow
            title="Follow and stop"
            description="Watch the preview while the agent works. Use Stop in the chat to interrupt the task. Closing the preview only hides it."
          />
          {snapShotAvailable ? (
            <p className="@xl/settings:px-4 px-3 pt-1 text-xs text-muted-foreground">
              SnapShot is separate: it attaches a window image without giving the agent control.
            </p>
          ) : null}
          {!acknowledged ? (
            <div className="@xl/settings:px-4 px-3 pt-2">
              <Button size="sm" variant="outline" onClick={dismiss}>
                Got it
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
