import type { KnownTerminalSession } from "@spiritdevs/client-runtime/state/terminal";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import type { DiscoveredLocalServer, ScopedThreadRef } from "@spiritdevs/contracts";
import {
  ChevronDownIcon,
  LoaderCircleIcon,
  RadioTower,
  TerminalSquare,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";

import { getTerminalLabel, resolveTerminalSessionLabel } from "@spiritdevs/shared/terminalLabels";
import { cn } from "~/lib/utils";
import { useDiscoveredPorts } from "~/portDiscoveryState";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import {
  THREAD_DETAILS_PANEL_DISCLOSURE_ROW_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { Collapsible, CollapsiblePanel } from "./ui/collapsible";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { DevelopmentServerRow } from "./DevelopmentServerRow";
import { selectActiveTerminalSessions } from "./EnvironmentRuntimeControls.logic";

function RuntimeDisclosure({
  icon,
  label,
  count,
  displayMode,
  open,
  onOpenChange,
  children,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  displayMode: "card" | "panel";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <button
        type="button"
        data-keep-action-card-open
        aria-expanded={open}
        className={cn(
          displayMode === "panel"
            ? THREAD_DETAILS_PANEL_DISCLOSURE_ROW_CLASS
            : "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        )}
        onClick={() => onOpenChange(!open)}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
          {count}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-4 transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </span>
      </button>
      <CollapsiblePanel>
        <div className="space-y-0.5 pt-0.5">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function TerminalRow({
  session,
  onOpen,
  onKill,
  killing,
}: {
  session: KnownTerminalSession;
  onOpen: (terminalId: string) => void;
  onKill: (terminalId: string) => void;
  killing: boolean;
}) {
  const terminalId = session.target.terminalId;
  const label = resolveTerminalSessionLabel(terminalId, session.state.summary);
  const fallbackLabel = getTerminalLabel(terminalId);

  return (
    <div className="flex w-full items-center rounded-md hover:bg-accent focus-within:bg-accent">
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1.5 pr-1 pl-8 text-left text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpen(terminalId)}
      >
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {label !== fallbackLabel ? (
          <span className="shrink-0 text-xs text-muted-foreground">{fallbackLabel}</span>
        ) : null}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="mr-1 hover:text-destructive"
        data-keep-action-card-open
        aria-label={`Kill ${label}`}
        title="Kill terminal"
        disabled={killing}
        onClick={() => onKill(terminalId)}
      >
        {killing ? (
          <LoaderCircleIcon
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Trash2Icon aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}

export const DevelopmentEnvironmentControls = memo(function DevelopmentEnvironmentControls({
  threadRef,
  enabled,
  displayMode = "card",
}: {
  threadRef: ScopedThreadRef;
  enabled: boolean;
  displayMode?: "card" | "panel";
}) {
  const [serversOpen, setServersOpen] = useState(false);
  const [stoppingServerKey, setStoppingServerKey] = useState<string | null>(null);
  const servers = useDiscoveredPorts(threadRef.environmentId, enabled);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopDiscoveredServer = useAtomCommand(previewEnvironment.stopDiscoveredServer, {
    reportFailure: false,
  });

  const handleOpenServer = useCallback(
    (server: DiscoveredLocalServer) => {
      void openDiscoveredPort({ threadRef, port: server, openPreview }).then((result) => {
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to open local server",
          description: error instanceof Error ? error.message : "The preview could not be opened.",
        });
      });
    },
    [openPreview, threadRef],
  );

  const handleCopyServer = useCallback((server: DiscoveredLocalServer) => {
    void writeTextToClipboard(server.url, "development server URL").then(
      () => {
        toastManager.add({ type: "success", title: "Development server URL copied" });
      },
      (error) => {
        toastManager.add({
          type: "error",
          title: "Unable to copy URL",
          description: error instanceof Error ? error.message : "The URL could not be copied.",
        });
      },
    );
  }, []);

  const handleStopServer = useCallback(
    (server: DiscoveredLocalServer) => {
      if (server.pid === null) return;
      const serverKey = `${server.host}:${server.port}`;
      setStoppingServerKey(serverKey);
      void stopDiscoveredServer({
        environmentId: threadRef.environmentId,
        input: { port: server.port, pid: server.pid },
      }).then((result) => {
        setStoppingServerKey((current) => (current === serverKey ? null : current));
        if (result._tag === "Success") {
          toastManager.add({
            type: "success",
            title: `Stopping localhost:${server.port}`,
          });
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to stop development server",
          description: error instanceof Error ? error.message : "The server could not be stopped.",
        });
      });
    },
    [stopDiscoveredServer, threadRef.environmentId],
  );

  if (servers.length === 0) return null;

  return (
    <section
      aria-label="Local servers"
      className={cn(
        "border-t",
        displayMode === "panel" ? "border-border/65" : "border-border/70 py-2",
      )}
    >
      {displayMode === "panel" ? (
        <div className="px-3.5 pb-1 pt-3">
          <p className="text-[11px] font-medium text-muted-foreground">Development environments</p>
        </div>
      ) : (
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
          Development environments
        </p>
      )}
      <div className={displayMode === "panel" ? "px-2 pb-2.5" : undefined}>
        <RuntimeDisclosure
          icon={
            <RadioTower
              className={cn(
                "size-4 shrink-0",
                displayMode === "panel" && THREAD_DETAILS_PANEL_ICON_CLASS,
                displayMode === "panel" && "-translate-x-2",
              )}
              aria-hidden="true"
            />
          }
          label="Local servers"
          count={servers.length}
          displayMode={displayMode}
          open={serversOpen}
          onOpenChange={setServersOpen}
        >
          {servers.map((server) => (
            <DevelopmentServerRow
              key={`${server.host}:${server.port}`}
              server={server}
              onOpen={handleOpenServer}
              onCopy={handleCopyServer}
              onStop={handleStopServer}
              stopping={stoppingServerKey === `${server.host}:${server.port}`}
            />
          ))}
        </RuntimeDisclosure>
      </div>
    </section>
  );
});

export const TerminalRuntimeControls = memo(function TerminalRuntimeControls({
  threadRef,
  displayMode = "card",
}: {
  threadRef: ScopedThreadRef;
  displayMode?: "card" | "panel";
}) {
  const [terminalsOpen, setTerminalsOpen] = useState(false);
  const [killingTerminalId, setKillingTerminalId] = useState<string | null>(null);
  const killTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const activeTerminalSessions = useMemo(
    () => selectActiveTerminalSessions(knownTerminalSessions),
    [knownTerminalSessions],
  );
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const handleOpenTerminal = useCallback(
    (terminalId: string) => {
      const panelSurface = rightPanelState.surfaces.find(
        (surface) => surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
      );
      if (panelSurface?.kind === "terminal") {
        const panelStore = useRightPanelStore.getState();
        panelStore.activateTerminal(threadRef, panelSurface.id, terminalId);
        panelStore.show(threadRef);
        return;
      }
      useTerminalUiStateStore
        .getState()
        .ensureTerminal(threadRef, terminalId, { open: true, active: true });
    },
    [rightPanelState.surfaces, threadRef],
  );
  const handleKillTerminal = useCallback(
    (terminalId: string) => {
      setKillingTerminalId(terminalId);
      void killTerminal({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
      }).then((result) => {
        setKillingTerminalId((current) => (current === terminalId ? null : current));
        if (result._tag === "Success") {
          useTerminalUiStateStore.getState().closeTerminal(threadRef, terminalId);
          const panelStore = useRightPanelStore.getState();
          for (const surface of rightPanelState.surfaces) {
            if (surface.kind === "terminal" && surface.terminalIds.includes(terminalId)) {
              panelStore.closeTerminal(threadRef, surface.id, terminalId);
            }
          }
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to kill terminal",
          description: error instanceof Error ? error.message : "The terminal could not be killed.",
        });
      });
    },
    [killTerminal, rightPanelState.surfaces, threadRef],
  );

  if (activeTerminalSessions.length === 0) return null;

  return (
    <section
      aria-label="Running terminals"
      className={cn(
        "border-t",
        displayMode === "panel" ? "border-border/65" : "border-border/70 py-2",
      )}
    >
      {displayMode === "panel" ? (
        <div className="px-3.5 pb-1 pt-3">
          <p className="text-[11px] font-medium text-muted-foreground">Terminals</p>
        </div>
      ) : (
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Terminals</p>
      )}
      <div className={displayMode === "panel" ? "px-2 pb-2.5" : undefined}>
        <RuntimeDisclosure
          icon={
            <TerminalSquare
              className={cn(
                "size-4 shrink-0",
                displayMode === "panel" && THREAD_DETAILS_PANEL_ICON_CLASS,
              )}
              aria-hidden="true"
            />
          }
          label="Running terminals"
          count={activeTerminalSessions.length}
          displayMode={displayMode}
          open={terminalsOpen}
          onOpenChange={setTerminalsOpen}
        >
          {activeTerminalSessions.map((session) => (
            <TerminalRow
              key={session.target.terminalId}
              session={session}
              onOpen={handleOpenTerminal}
              onKill={handleKillTerminal}
              killing={killingTerminalId === session.target.terminalId}
            />
          ))}
        </RuntimeDisclosure>
      </div>
    </section>
  );
});

export const EnvironmentRuntimeControls = memo(function EnvironmentRuntimeControls({
  threadRef,
  enabled,
  displayMode = "card",
}: {
  threadRef: ScopedThreadRef;
  enabled: boolean;
  displayMode?: "card" | "panel";
}) {
  return (
    <>
      <DevelopmentEnvironmentControls
        threadRef={threadRef}
        enabled={enabled}
        displayMode={displayMode}
      />
      <TerminalRuntimeControls threadRef={threadRef} displayMode={displayMode} />
    </>
  );
});
