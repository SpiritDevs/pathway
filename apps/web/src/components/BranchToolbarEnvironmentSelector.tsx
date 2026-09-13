import { EnvironmentStorageIcon } from "./navigation/EnvironmentStorageIcon";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { CloudIcon, MonitorIcon, PlusIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { AutoPlacementOption, EnvironmentOption } from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

// Sentinel item value for the trailing action row. The Select is controlled by
// `environmentId`, so picking it never lands in `value`: `onValueChange` routes
// it to the link flow and leaves the selection where it was.
const LINK_ENVIRONMENT_VALUE = "__link-environment__";

interface BranchToolbarEnvironmentSelectorProps {
  autoPlacement?: AutoPlacementOption | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly Omit<EnvironmentOption, "projectId">[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  /** Opens the flow that attaches this project to another environment. */
  onLinkEnvironmentRequest?: () => void;
  displayMode?: "toolbar" | "panel";
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoPlacement,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onLinkEnvironmentRequest,
  displayMode = "toolbar",
}: BranchToolbarEnvironmentSelectorProps) {
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () => [
      ...(autoPlacement ? [{ value: "__auto-placement__", label: autoPlacement.label }] : []),
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    ],
    [availableEnvironments, autoPlacement],
  );

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  // A single environment still opens: the popup carries "Link environment",
  // which is the only in-composer way to get a second one.
  if (
    envLocked ||
    (!autoPlacement && onEnvironmentChange === undefined && onLinkEnvironmentRequest === undefined)
  ) {
    return (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 sm:text-xs",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        data-composer-context-control
      >
        {activeEnvironment?.isPrimary ? (
          <MonitorIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
        ) : (
          <CloudIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
        )}
        <span
          data-composer-label
          className={
            displayMode === "panel"
              ? "min-w-0 max-w-none flex-1 text-left"
              : "min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          }
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            {activeEnvironment?.label ?? "Run on"}
          </span>
        </span>
        <EnvironmentStorageIcon environmentId={environmentId} />
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={autoPlacement?.active ? "__auto-placement__" : environmentId}
      onValueChange={(value) => {
        if (value === "__auto-placement__") {
          autoPlacement?.onSelect();
          return;
        }
        if (value === LINK_ENVIRONMENT_VALUE) {
          onLinkEnvironmentRequest?.();
          return;
        }
        onEnvironmentChange?.(value as EnvironmentId);
      }}
      items={environmentItems}
    >
      <SelectTrigger
        variant="ghost"
        size={displayMode === "panel" ? "default" : "xs"}
        className={cn(
          "min-w-0 max-w-full font-medium",
          displayMode === "panel" && THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
        )}
        aria-label="Run on"
        data-composer-context-control
      >
        {activeEnvironment?.isPrimary ? (
          <MonitorIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
        ) : (
          <CloudIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
        )}
        <span
          data-composer-label
          className={
            displayMode === "panel"
              ? "min-w-0 max-w-none flex-1 text-left"
              : "min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          }
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            {autoPlacement?.active ? autoPlacement.label : <SelectValue />}
          </span>
        </span>
        {!autoPlacement?.active ? <EnvironmentStorageIcon environmentId={environmentId} /> : null}
      </SelectTrigger>
      <SelectPopup
        {...(displayMode === "panel"
          ? {
              alignItemWithTrigger: false,
              popupClassName: THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
            }
          : {})}
      >
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {autoPlacement && (
            <>
              <SelectItem value="__auto-placement__" disabled={autoPlacement.disabled}>
                {autoPlacement.label}
              </SelectItem>
              <SelectSeparator />
            </>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="flex w-full min-w-0 items-center gap-1.5">
                {env.isPrimary ? (
                  <MonitorIcon className="size-3" />
                ) : (
                  <CloudIcon className="size-3" />
                )}
                <span className="min-w-0 flex-1 truncate">{env.label}</span>
                <EnvironmentStorageIcon environmentId={env.environmentId} />
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
        {onLinkEnvironmentRequest ? (
          <>
            <SelectSeparator />
            <SelectItem value={LINK_ENVIRONMENT_VALUE}>
              <span className="inline-flex items-center gap-1.5">
                <PlusIcon className="size-3" />
                Link environment
              </span>
            </SelectItem>
          </>
        ) : null}
      </SelectPopup>
    </Select>
  );
});
