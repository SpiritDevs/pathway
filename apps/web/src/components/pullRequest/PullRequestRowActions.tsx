import type { SourcedPullRequestListEntry } from "~/state/pullRequests";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

export interface PullRequestRowActionTarget {
  id: number;
  entry: SourcedPullRequestListEntry;
  x: number;
  y: number;
  trigger: HTMLButtonElement;
}

/** One action host for the list. Closing the menu keeps pending actions and dialogs alive. */
export function PullRequestRowActions({
  target,
  onActed,
}: {
  target: PullRequestRowActionTarget;
  onActed: () => void;
}) {
  const [open, setOpen] = useState(true);
  const { entry, x, y, trigger } = target;
  const reference = useMemo(
    () => ({ projectId: entry.projectId, repository: entry.repository, number: entry.number }),
    [entry.projectId, entry.repository, entry.number],
  );
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }), [x, y]);
  const renderActions = useCallback(
    (items: ReactNode) => (
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          className="pointer-events-none fixed size-0"
          nativeButton={false}
          render={<span />}
          style={{ left: x, top: y }}
          tabIndex={-1}
        >
          <span className="sr-only">Pull request actions</span>
        </MenuTrigger>
        <MenuPopup
          align="start"
          anchor={anchor}
          side="inline-end"
          className="max-w-[calc(100vw-1rem)] min-w-72"
          finalFocus={() => (trigger.isConnected ? trigger : false)}
        >
          {items}
        </MenuPopup>
      </Menu>
    ),
    [anchor, open, trigger, x, y],
  );
  return (
    <PullRequestDetailPanel
      environmentId={entry.environmentId}
      reference={reference}
      onActed={onActed}
      renderActions={renderActions}
    />
  );
}
