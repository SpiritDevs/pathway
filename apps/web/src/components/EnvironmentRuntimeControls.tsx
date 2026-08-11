import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, RadioTower, TerminalSquare } from "lucide-react";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";

import { getTerminalLabel, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { cn } from "~/lib/utils";
import { useDiscoveredPorts } from "~/portDiscoveryState";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { Collapsible, CollapsiblePanel } from "./ui/collapsible";
import { toastManager } from "./ui/toast";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";

export function selectActiveTerminalSessions(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<KnownTerminalSession> {
  return sessions.filter(
    (session) => session.state.status === "starting" || session.state.status === "running",
  );
}

function RuntimeDisclosure({
  icon,
  label,
  count,
  open,
  onOpenChange,
  children,
}: {
  icon: ReactNode;
  label: string;
  count: number;
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
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpenChange(!open)}
      >
        {icon}
        <span className="truncate">{label}</span>
        <span className="ml-auto flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
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

function ServerRow({
  server,
  onOpen,
}: {
  server: DiscoveredLocalServer;
  onOpen: (server: DiscoveredLocalServer) => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(server)}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{server.processName ?? "Local server"}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        localhost:{server.port}
      </span>
    </button>
  );
}

function TerminalRow({
  session,
  onOpen,
}: {
  session: KnownTerminalSession;
  onOpen: (terminalId: string) => void;
}) {
  const terminalId = session.target.terminalId;
  const label = resolveTerminalSessionLabel(terminalId, session.state.summary);
  const fallbackLabel = getTerminalLabel(terminalId);

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(terminalId)}
    >
      <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {label !== fallbackLabel ? (
        <span className="shrink-0 text-xs text-muted-foreground">{fallbackLabel}</span>
      ) : null}
    </button>
  );
}

export const EnvironmentRuntimeControls = memo(function EnvironmentRuntimeControls({
  threadRef,
  enabled,
}: {
  threadRef: ScopedThreadRef;
  enabled: boolean;
}) {
  const [serversOpen, setServersOpen] = useState(false);
  const [terminalsOpen, setTerminalsOpen] = useState(false);
  const servers = useDiscoveredPorts(threadRef.environmentId, enabled);
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
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

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

  if (servers.length === 0 && activeTerminalSessions.length === 0) return null;

  return (
    <>
      {servers.length > 0 ? (
        <section aria-label="Local servers" className="border-t border-border/70 py-2">
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Servers</p>
          <RuntimeDisclosure
            icon={<RadioTower className="size-4 shrink-0" aria-hidden="true" />}
            label="Local servers"
            count={servers.length}
            open={serversOpen}
            onOpenChange={setServersOpen}
          >
            {servers.map((server) => (
              <ServerRow
                key={`${server.host}:${server.port}`}
                server={server}
                onOpen={handleOpenServer}
              />
            ))}
          </RuntimeDisclosure>
        </section>
      ) : null}

      {activeTerminalSessions.length > 0 ? (
        <section aria-label="Running terminals" className="border-t border-border/70 py-2">
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Terminals</p>
          <RuntimeDisclosure
            icon={<TerminalSquare className="size-4 shrink-0" aria-hidden="true" />}
            label="Running terminals"
            count={activeTerminalSessions.length}
            open={terminalsOpen}
            onOpenChange={setTerminalsOpen}
          >
            {activeTerminalSessions.map((session) => (
              <TerminalRow
                key={session.target.terminalId}
                session={session}
                onOpen={handleOpenTerminal}
              />
            ))}
          </RuntimeDisclosure>
        </section>
      ) : null}
    </>
  );
});
