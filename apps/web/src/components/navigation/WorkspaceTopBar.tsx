import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isElectron } from "../../env";
import { cn, isMacPlatform } from "../../lib/utils";
import { T3ConnectProfileButton } from "../clerk/T3ConnectSidebarSignIn";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SyncStatusIndicator } from "./SyncStatusIndicator";
import { type WorkspaceHistoryEntry, workspaceHistoryTracker } from "./workspaceHistory.logic";

const HISTORY_LONG_PRESS_MS = 500;

type HistoryDirection = "back" | "forward";

function WorkspaceHistoryButton({
  direction,
  entries,
  currentIndex,
  onNavigate,
}: {
  direction: HistoryDirection;
  entries: ReadonlyArray<WorkspaceHistoryEntry>;
  currentIndex: number;
  onNavigate: (delta: number) => void;
}) {
  const enabled = entries.length > 0;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  const triggerId = useId();
  const popupId = `${triggerId}-history`;
  const label = direction === "back" ? "Back" : "Forward";
  const Icon = direction === "back" ? ArrowLeft : ArrowRight;

  const clearPressTimer = useCallback(() => {
    if (pressTimerRef.current === null) return;
    clearTimeout(pressTimerRef.current);
    pressTimerRef.current = null;
  }, []);

  useEffect(() => clearPressTimer, [clearPressTimer]);

  const openHistory = useCallback(() => {
    if (!enabled) return;
    suppressClickRef.current = true;
    setOpen(true);
  }, [enabled]);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!enabled || event.button !== 0) return;
    suppressClickRef.current = false;
    clearPressTimer();
    pressTimerRef.current = setTimeout(openHistory, HISTORY_LONG_PRESS_MS);
  };

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    clearPressTimer();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      return;
    }
    onNavigate(direction === "back" ? -1 : 1);
  };

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    event.preventDefault();
    openHistory();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" || !enabled) return;
    event.preventDefault();
    openHistory();
  };

  return (
    <Menu onOpenChange={setOpen} open={open} triggerId={triggerId}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-controls={enabled ? popupId : undefined}
              aria-expanded={enabled ? open : undefined}
              aria-haspopup={enabled ? "menu" : undefined}
              aria-label={label}
              className="[-webkit-app-region:no-drag]"
              disabled={!enabled}
              id={triggerId}
              onClick={handleClick}
              onContextMenu={handleContextMenu}
              onKeyDown={handleKeyDown}
              onPointerCancel={clearPressTimer}
              onPointerDown={handlePointerDown}
              onPointerLeave={clearPressTimer}
              onPointerUp={clearPressTimer}
              ref={buttonRef}
              size="icon-xs"
              type="button"
              variant="ghost"
            />
          }
        >
          <Icon />
        </TooltipTrigger>
        <TooltipPopup>{enabled ? `${label} · Hold for history` : label}</TooltipPopup>
      </Tooltip>

      {enabled ? (
        <MenuPopup
          align="start"
          anchor={buttonRef}
          className="w-72"
          id={popupId}
          side="bottom"
          sideOffset={6}
        >
          <MenuGroup>
            <MenuGroupLabel>
              {direction === "back" ? "Back history" : "Forward history"}
            </MenuGroupLabel>
            {entries.map((entry) => {
              const distance = Math.abs(entry.index - currentIndex);
              return (
                <MenuItem
                  key={entry.index}
                  onClick={() => {
                    setOpen(false);
                    onNavigate(entry.index - currentIndex);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {distance === 1 ? "1 step" : `${distance} steps`}
                  </span>
                </MenuItem>
              );
            })}
          </MenuGroup>
        </MenuPopup>
      ) : null}
    </Menu>
  );
}

function WorkspaceHistoryControls() {
  const router = useRouter();
  const tracker = workspaceHistoryTracker(router.history);
  const history = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot);
  const navigate = useCallback((delta: number) => router.history.go(delta), [router.history]);

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="History navigation">
      <WorkspaceHistoryButton
        currentIndex={history.index}
        direction="back"
        entries={history.backEntries}
        onNavigate={navigate}
      />
      <WorkspaceHistoryButton
        currentIndex={history.index}
        direction="forward"
        entries={history.forwardEntries}
        onNavigate={navigate}
      />
    </div>
  );
}

export function WorkspaceTopBar() {
  const isMacDesktop =
    isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

  return (
    <header
      className={cn(
        "hidden min-h-11 shrink-0 items-center justify-between bg-sidebar pr-4 md:flex",
        isMacDesktop ? "pl-8" : "pl-2",
        isElectron && "drag-region",
      )}
      aria-label="Workspace top bar"
      data-workspace-top-bar=""
    >
      <WorkspaceHistoryControls />
      <div className="flex items-center gap-2">
        <SyncStatusIndicator />
        <T3ConnectProfileButton />
      </div>
    </header>
  );
}
