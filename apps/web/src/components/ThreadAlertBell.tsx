import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { BellIcon, BellOffIcon } from "lucide-react";
import {
  ALERT_EVENT_KEYS,
  type AlertPolicy,
  type AlertPolicyOverride,
  type AlertPolicyRow,
} from "@spiritdevs/contracts/threadAlerts";
import { threadAlertMutationsAtom, threadAlertPoliciesReadyAtom } from "../threadAlerts/state";
import { ALERT_EVENT_LABELS, bulkAlertChoices, threadPolicyView } from "../threadAlerts/policyUi";
import { Popover, PopoverPopup, PopoverTitle } from "./ui/popover";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

export function AlertPolicyChoices({
  choices,
  inherited,
  disabled,
  onChange,
}: {
  choices: AlertPolicyOverride;
  inherited: AlertPolicy;
  disabled?: boolean;
  onChange: (choices: AlertPolicyOverride) => void;
}) {
  return (
    <div className="space-y-2">
      {ALERT_EVENT_KEYS.map((key) => (
        <label key={key} className="flex items-center justify-between gap-4 text-sm">
          <span>{ALERT_EVENT_LABELS[key]}</span>
          <select
            aria-label={ALERT_EVENT_LABELS[key]}
            disabled={disabled}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            value={choices[key] === undefined ? "inherit" : choices[key] ? "on" : "off"}
            onChange={(event) => {
              const next = { ...choices };
              if (event.target.value === "inherit") delete next[key];
              else next[key] = event.target.value === "on";
              onChange(next);
            }}
          >
            <option value="inherit">Inherit ({inherited[key] ? "On" : "Off"})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
      ))}
    </div>
  );
}
export function ThreadAlertBell({
  projectKey,
  threadKey,
  policies,
  modifierHeld = false,
}: {
  projectKey: string | null;
  threadKey: string;
  policies: readonly AlertPolicyRow[] | null;
  modifierHeld?: boolean;
}) {
  const mutations = useAtomValue(threadAlertMutationsAtom);
  const policiesReady = useAtomValue(threadAlertPoliciesReadyAtom);
  const view = threadPolicyView(policies, projectKey, threadKey);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // A modifier-hover opens a peek. It closes once the pointer leaves both the bell and the
  // popup, or the modifier is released away from the popup. Clicking inside keeps it open.
  const peeking = useRef(false);
  const overPopup = useRef(false);
  const peekClose = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPeekClose = () => {
    if (peekClose.current !== null) clearTimeout(peekClose.current);
    peekClose.current = null;
  };
  const openMenu = (peek: boolean) => {
    cancelPeekClose();
    peeking.current = peek && (!open || peeking.current);
    setOpen(true);
  };
  const closePeek = () => {
    cancelPeekClose();
    if (peeking.current && !overPopup.current) {
      peeking.current = false;
      setOpen(false);
    }
  };
  const schedulePeekClose = () => {
    if (!peeking.current) return;
    cancelPeekClose();
    // Crossing the gap from the bell into the popup must not close it.
    peekClose.current = setTimeout(closePeek, 150);
  };
  useEffect(() => {
    if (modifierHeld && anchor.current?.matches(":hover")) openMenu(true);
    else if (!modifierHeld) closePeek();
  }, [modifierHeld]);
  useEffect(() => cancelPeekClose, []);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const clearLongPress = () => {
    if (longPress.current !== null) clearTimeout(longPress.current);
    longPress.current = null;
  };
  useEffect(() => clearLongPress, []);
  const save = async (choices: AlertPolicyOverride) => {
    if (!mutations || !policiesReady || saving) return;
    setSaving(true);
    try {
      await mutations.upsert({ scopeKind: "thread", scopeKey: threadKey, choices });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save thread alerts",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setSaving(false);
    }
  };
  const label = `Thread alerts ${view.state === "mixed" ? "partly on" : view.state}, ${view.explicit ? "thread override" : "inherited"}`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          cancelPeekClose();
          peeking.current = false;
          overPopup.current = false;
        }
        setOpen(next);
      }}
    >
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        title={`${label}. Right-click for individual alerts.`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!mutations || !policiesReady || policies === null || saving}
        // An off bell leaves the layout at rest so the pin sits beside the status.
        className={`relative size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${view.state === "off" && !open ? "hidden group-hover/sidebar-row:inline-flex group-focus-within/sidebar-row:inline-flex" : "inline-flex"}`}
        onPointerDown={(event) => {
          event.stopPropagation();
          suppressClick.current = false;
          if (event.pointerType === "touch")
            longPress.current = setTimeout(() => {
              suppressClick.current = true;
              openMenu(false);
            }, 500);
        }}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerLeave={clearLongPress}
        onMouseEnter={(event) => {
          if (event.ctrlKey || event.metaKey) openMenu(true);
          else cancelPeekClose();
        }}
        onMouseMove={(event) => {
          if (event.ctrlKey || event.metaKey) openMenu(true);
        }}
        onMouseLeave={schedulePeekClose}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMenu(false);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            (event.key === "Enter" && (event.ctrlKey || event.metaKey)) ||
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            openMenu(false);
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (event.ctrlKey || event.metaKey) openMenu(false);
          else void save(bulkAlertChoices(view.effective));
        }}
      >
        {view.state === "off" ? (
          <BellOffIcon className="size-3.5" />
        ) : (
          <BellIcon
            className="size-3.5"
            strokeDasharray={view.state === "mixed" ? "2 2" : undefined}
          />
        )}
      </button>
      <PopoverPopup
        anchor={anchor}
        align="end"
        className="w-80"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={() => {
          peeking.current = false;
        }}
        onMouseEnter={() => {
          overPopup.current = true;
          cancelPeekClose();
        }}
        onMouseLeave={() => {
          overPopup.current = false;
          schedulePeekClose();
        }}
      >
        <PopoverTitle>Thread alerts</PopoverTitle>
        <p className="mb-4 text-xs text-muted-foreground">
          {view.explicit ? "This thread has custom choices." : "Using project defaults."} Sound and
          OS delivery follow this device's settings.
        </p>
        <AlertPolicyChoices
          choices={view.choices}
          inherited={view.inherited}
          disabled={!mutations || !policiesReady || saving}
          onChange={(choices) => void save(choices)}
        />
        <Button
          className="mt-4"
          size="sm"
          variant="outline"
          disabled={!mutations || !policiesReady || saving || !view.explicit}
          onClick={() => void save({})}
        >
          Use project defaults
        </Button>
      </PopoverPopup>
    </Popover>
  );
}
