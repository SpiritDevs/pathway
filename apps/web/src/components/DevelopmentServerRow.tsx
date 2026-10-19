import type { DiscoveredLocalServer } from "@spiritdevs/contracts";
import { CopyIcon, ExternalLinkIcon, LoaderCircleIcon, SquareIcon } from "lucide-react";

import { Button } from "./ui/button";
import {
  DEVELOPMENT_SERVER_ROW_ACTIONS,
  getDevelopmentServerRowState,
} from "./DevelopmentServerRow.logic";

export function DevelopmentServerRow({
  server,
  onOpen,
  onCopy,
  onStop,
  stopping,
}: {
  server: DiscoveredLocalServer;
  onOpen: (server: DiscoveredLocalServer) => void;
  onCopy: (server: DiscoveredLocalServer) => void;
  onStop: (server: DiscoveredLocalServer) => void;
  stopping: boolean;
}) {
  const { address, canStop, label } = getDevelopmentServerRowState(server);

  return (
    <div className="group/server-row relative flex w-full items-center rounded-md hover:bg-accent focus-within:bg-accent">
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-left text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpen(server)}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground transition-opacity group-hover/server-row:opacity-0 group-focus-within/server-row:opacity-0 pointer-coarse:opacity-0">
          {address}
        </span>
      </button>
      <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/server-row:pointer-events-auto group-hover/server-row:opacity-100 group-focus-within/server-row:pointer-events-auto group-focus-within/server-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-keep-action-card-open
          aria-label={`${DEVELOPMENT_SERVER_ROW_ACTIONS.open} ${label}`}
          title={DEVELOPMENT_SERVER_ROW_ACTIONS.open}
          onClick={() => onOpen(server)}
        >
          <ExternalLinkIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-keep-action-card-open
          aria-label={`${DEVELOPMENT_SERVER_ROW_ACTIONS.copy} for ${address}`}
          title={DEVELOPMENT_SERVER_ROW_ACTIONS.copy}
          onClick={() => onCopy(server)}
        >
          <CopyIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="hover:text-destructive"
          data-keep-action-card-open
          aria-label={`${DEVELOPMENT_SERVER_ROW_ACTIONS.stop} ${label}`}
          title={canStop ? DEVELOPMENT_SERVER_ROW_ACTIONS.stop : "Process unavailable"}
          disabled={!canStop || stopping}
          onClick={() => onStop(server)}
        >
          {stopping ? (
            <LoaderCircleIcon
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <SquareIcon aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}
