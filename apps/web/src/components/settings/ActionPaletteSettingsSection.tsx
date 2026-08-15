import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, GripVerticalIcon, InfoIcon, RotateCcwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  actionPalettePreferencesFromResolved,
  isDefaultActionPaletteConfiguration,
  resolveActionPaletteSections,
  type ActionPaletteSectionId,
  type ResolvedActionPaletteSection,
} from "../chat/actionPaletteSections";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function partitionSections(sections: ReadonlyArray<ResolvedActionPaletteSection>) {
  return {
    active: sections.filter((section) => section.visible),
    inactive: sections.filter((section) => !section.visible),
  };
}

/** Reorder one visibility group while keeping Active before Inactive in persistence. */
export function reorderActionPaletteSectionGroup(
  sections: ReadonlyArray<ResolvedActionPaletteSection>,
  visible: boolean,
  activeId: ActionPaletteSectionId,
  overId: ActionPaletteSectionId,
): ReadonlyArray<ResolvedActionPaletteSection> {
  const { active, inactive } = partitionSections(sections);
  const group = visible ? active : inactive;
  const from = group.findIndex((section) => section.id === activeId);
  const to = group.findIndex((section) => section.id === overId);
  if (from < 0 || to < 0 || from === to) return sections;

  const reordered = arrayMove(group, from, to);
  return visible ? [...reordered, ...inactive] : [...active, ...reordered];
}

/** Move a toggled area to the end of its new visibility group. */
export function setActionPaletteSectionVisibility(
  sections: ReadonlyArray<ResolvedActionPaletteSection>,
  id: ActionPaletteSectionId,
  visible: boolean,
): ReadonlyArray<ResolvedActionPaletteSection> {
  const { active, inactive } = partitionSections(sections);
  const source = visible ? inactive : active;
  const moved = source.find((section) => section.id === id);
  if (!moved || moved.visible === visible) return sections;

  if (visible) {
    return [
      ...active,
      { ...moved, visible: true },
      ...inactive.filter((section) => section.id !== id),
    ];
  }
  return [
    ...active.filter((section) => section.id !== id),
    ...inactive,
    { ...moved, visible: false },
  ];
}

function SortableActionPaletteCard({
  section,
  siblingCount,
  onKeyboardMove,
  onVisibilityChange,
}: {
  section: ResolvedActionPaletteSection;
  siblingCount: number;
  onKeyboardMove: (direction: -1 | 1) => void;
  onVisibilityChange: (visible: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: section.id });
  const sortableKeyDown = listeners?.onKeyDown;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex h-9 min-w-0 items-center gap-1.5 bg-card/45 px-2",
        isDragging ? "z-10 bg-accent/80 opacity-80 shadow-sm" : "hover:bg-accent/25",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${section.label}`}
        disabled={siblingCount < 2}
        onKeyDown={(event) => {
          if (!isDragging && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            onKeyboardMove(event.key === "ArrowUp" ? -1 : 1);
            return;
          }
          sortableKeyDown?.(event);
        }}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/55 outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-35"
      >
        <GripVerticalIcon aria-hidden className="size-3.5" />
      </button>
      <p className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.005em] text-foreground">
        {section.label}
      </p>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`About ${section.label}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/55 outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <InfoIcon aria-hidden className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="top" className="max-w-64">
          {section.description}
        </TooltipPopup>
      </Tooltip>
      <Switch
        checked={section.visible}
        aria-label={`Show ${section.label}`}
        onCheckedChange={(visible) => onVisibilityChange(Boolean(visible))}
      />
    </li>
  );
}

function ActionPaletteSectionList({
  sections,
  visible,
  onReorder,
  onVisibilityChange,
}: {
  sections: ReadonlyArray<ResolvedActionPaletteSection>;
  visible: boolean;
  onReorder: (activeId: ActionPaletteSectionId, overId: ActionPaletteSectionId) => void;
  onVisibilityChange: (id: ActionPaletteSectionId, visible: boolean) => void;
}) {
  const [announcement, setAnnouncement] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null) return;
    onReorder(
      String(event.active.id) as ActionPaletteSectionId,
      String(event.over.id) as ActionPaletteSectionId,
    );
  };
  const groupLabel = visible ? "Active" : "Inactive";

  return (
    <section aria-label={`${groupLabel} action palette areas`}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={handleDragEnd}
      >
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card/30">
          <SortableContext
            items={sections.map((section) => section.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol
              aria-label={`${groupLabel} action palette areas`}
              className="m-0 list-none divide-y divide-border/60 p-0"
            >
              {sections.map((section) => (
                <SortableActionPaletteCard
                  key={section.id}
                  section={section}
                  siblingCount={sections.length}
                  onKeyboardMove={(direction) => {
                    const index = sections.findIndex((candidate) => candidate.id === section.id);
                    const destination = index + direction;
                    const over = sections[destination];
                    if (!over) return;
                    onReorder(section.id, over.id);
                    setAnnouncement(
                      `${section.label} moved to position ${destination + 1} of ${sections.length}.`,
                    );
                  }}
                  onVisibilityChange={(nextVisible) => onVisibilityChange(section.id, nextVisible)}
                />
              ))}
            </ol>
          </SortableContext>
          {sections.length === 0 ? (
            <p className="flex h-9 items-center justify-center px-3 text-xs text-muted-foreground/70">
              No {groupLabel.toLowerCase()} areas
            </p>
          ) : null}
        </div>
      </DndContext>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}

export function ActionPaletteSettingsPanel() {
  const preferences = useClientSettings((settings) => settings.actionPaletteSections);
  const updateSettings = useUpdateClientSettings();
  const sections = useMemo(() => resolveActionPaletteSections(preferences), [preferences]);
  const { active, inactive } = partitionSections(sections);
  const isDefault = isDefaultActionPaletteConfiguration(sections);

  const persist = (next: ReadonlyArray<ResolvedActionPaletteSection>) => {
    updateSettings({ actionPaletteSections: actionPalettePreferencesFromResolved(next) });
  };

  return (
    <SettingsPageContainer className="max-w-2xl">
      <div className="space-y-4">
        <Button
          render={<Link to="/settings/appearance" resetScroll={false} />}
          size="sm"
          variant="ghost"
          className="-ms-2 w-fit text-muted-foreground"
        >
          <ArrowLeftIcon aria-hidden className="size-4" />
          Appearance
        </Button>
        <SettingsSection
          {...searchableSetting("action-palette")}
          headerAction={
            <Button
              size="xs"
              variant="ghost"
              disabled={isDefault}
              onClick={() => updateSettings({ actionPaletteSections: [] })}
            >
              <RotateCcwIcon aria-hidden className="size-3.5" />
              Reset
            </Button>
          }
        >
          <p className="px-1 text-[13px] leading-[1.45] text-muted-foreground/80">
            Drag areas to reorder them, or focus a handle and use the arrow keys. Toggle an area to
            move it between the upper active list and lower inactive list.
          </p>
          <div className="space-y-3 pt-1">
            <ActionPaletteSectionList
              sections={active}
              visible
              onReorder={(activeId, overId) =>
                persist(reorderActionPaletteSectionGroup(sections, true, activeId, overId))
              }
              onVisibilityChange={(id, nextVisible) =>
                persist(setActionPaletteSectionVisibility(sections, id, nextVisible))
              }
            />
            <ActionPaletteSectionList
              sections={inactive}
              visible={false}
              onReorder={(activeId, overId) =>
                persist(reorderActionPaletteSectionGroup(sections, false, activeId, overId))
              }
              onVisibilityChange={(id, nextVisible) =>
                persist(setActionPaletteSectionVisibility(sections, id, nextVisible))
              }
            />
          </div>
        </SettingsSection>
      </div>
    </SettingsPageContainer>
  );
}
