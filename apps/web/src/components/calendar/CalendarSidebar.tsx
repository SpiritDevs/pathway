/**
 * `/calendar`'s one filter sidebar: the Layers, grouped by whose calendar they are.
 *
 * One sidebar for all four modes (ADR 0011). A layer turned off here disappears from Day, Week, and
 * Month at once, and from Timeline where it applies — a mode is a way of reading the same set, not
 * a different set.
 *
 * Nothing here shares a calendar or revokes access: sharing lives in the calendar settings surface,
 * because it is administration rather than filtering and belongs where the grant picker is.
 *
 * @module components/calendar/CalendarSidebar
 */
import { Link } from "@tanstack/react-router";
import { CalendarDaysIcon, CloudIcon, EyeIcon, EyeOffIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import { Button } from "../ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import type { CalendarLayer, CalendarLayerGroup } from "./calendarLayers.logic";
import { useCalendarLayers } from "./useCalendarSurface";

export function CalendarSidebar() {
  const { layerGroups, setGroupVisible, toggleLayer, viewer } = useCalendarLayers();

  return (
    <>
      <ContextualSidebarHeader title="Calendar" />
      <SidebarContent>
        {viewer.canRead === false ? (
          <SidebarGroup>
            <SidebarGroupLabel className="gap-2">
              <CalendarDaysIcon />
              Calendar
            </SidebarGroupLabel>
            <p className="px-2 py-3 text-xs leading-relaxed text-sidebar-muted-foreground/70">
              You do not have access to the calendar in this company.
            </p>
          </SidebarGroup>
        ) : (
          layerGroups.map((group) => (
            <LayerGroup
              group={group}
              key={group.id}
              onSetVisible={setGroupVisible}
              onToggle={toggleLayer}
            />
          ))
        )}
      </SidebarContent>
    </>
  );
}

/**
 * One owner's calendars, or the work sources.
 *
 * The group action turns the whole group off and back on, which is the gesture anyone reaches for
 * when they want one person's week rather than five people's — pressing every row in turn is the
 * same intent spelled out five times.
 */
function LayerGroup({
  group,
  onSetVisible,
  onToggle,
}: {
  readonly group: CalendarLayerGroup;
  readonly onSetVisible: (group: CalendarLayerGroup, visible: boolean) => void;
  readonly onToggle: (key: string) => void;
}) {
  if (group.layers.length === 0) return null;
  const anyVisible = group.layers.some((layer) => layer.visible);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
      <SidebarGroupAction
        aria-label={anyVisible ? `Hide ${group.title}` : `Show ${group.title}`}
        onClick={() => onSetVisible(group, !anyVisible)}
        title={anyVisible ? "Hide all" : "Show all"}
      >
        {anyVisible ? <EyeIcon /> : <EyeOffIcon />}
      </SidebarGroupAction>

      <SidebarMenu>
        {group.layers.map((layer) => (
          <SidebarMenuItem key={layer.key}>
            <SidebarMenuButton
              aria-pressed={layer.visible}
              className={cn("gap-2", !layer.visible && "text-sidebar-muted-foreground/60")}
              onClick={() => onToggle(layer.key)}
            >
              <LayerSwatch layer={layer} />
              <span className="truncate">{layer.label}</span>
              {layer.kind === "google" ? (
                <CloudIcon className="ms-auto size-3 shrink-0 text-sidebar-muted-foreground/60" />
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * The on/off mark. Filled when the layer is drawn and hollow when it is not, which is the same
 * shape either way — a row that changed size on toggle would make the list jump under the pointer.
 */
function LayerSwatch({ layer }: { readonly layer: CalendarLayer }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 shrink-0 rounded-[3px] border transition-colors motion-reduce:transition-none",
        layer.visible
          ? layer.readOnly
            ? "border-muted-foreground/60 bg-muted-foreground/50"
            : "border-primary/70 bg-primary/70"
          : "border-sidebar-border bg-transparent",
      )}
    />
  );
}

/** Shown in place of the grid when the viewer holds no `calendar.read` in the selected company. */
export function CalendarAccessDenied() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <CalendarDaysIcon className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">The calendar is not enabled for you here</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        Seeing calendars needs the <code className="font-mono">calendar.read</code> permission on
        one of your roles. An owner or a member with company administration can add it.
      </p>
      <Button render={<Link to="/settings/company-roles" />} size="sm" variant="outline">
        Open roles
      </Button>
    </div>
  );
}
