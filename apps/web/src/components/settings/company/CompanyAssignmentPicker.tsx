import { LegendList } from "@legendapp/list/react";
import { FilterIcon, SearchIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import {
  assignmentSelectionSummary,
  filterAssignmentItems,
  type AssignmentFilter,
  type AssignmentStatusFilter,
  type CompanyAssignmentPickerItem,
} from "./companyAssignmentPicker.logic";

const ROW_HEIGHT = 58;
const MAX_LIST_HEIGHT = 348;

export interface CompanyAssignmentPickerProps<Id extends string> {
  readonly label: string;
  readonly items: ReadonlyArray<CompanyAssignmentPickerItem<Id>>;
  readonly showStatusFilter?: boolean;
  readonly pending?: boolean;
  readonly disabled?: boolean;
  readonly onToggle: (id: Id, selected: boolean) => void;
  readonly onVisibleChange: (delta: {
    readonly addIds: ReadonlyArray<Id>;
    readonly removeIds: ReadonlyArray<Id>;
  }) => void;
}

export function CompanyAssignmentPicker<Id extends string>({
  label,
  items,
  showStatusFilter = false,
  pending = false,
  disabled = false,
  onToggle,
  onVisibleChange,
}: CompanyAssignmentPickerProps<Id>) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [assignment, setAssignment] = useState<AssignmentFilter>("all");
  const [status, setStatus] = useState<AssignmentStatusFilter>("all");
  const visibleItems = useMemo(
    () => filterAssignmentItems(items, { query, assignment, status }),
    [assignment, items, query, status],
  );
  const summary = useMemo(
    () => assignmentSelectionSummary(items, visibleItems),
    [items, visibleItems],
  );
  const blocked = disabled || pending;
  const hasFilters = query.length > 0 || assignment !== "all" || status !== "all";
  const reset = () => {
    setQuery("");
    setAssignment("all");
    setStatus("all");
  };

  return (
    <fieldset className="min-w-0 space-y-2" disabled={blocked}>
      <legend className="text-xs font-medium">{label}</legend>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={`Search ${label.toLocaleLowerCase()}`}
            className="[&_input]:ps-8"
            type="search"
            value={query}
            placeholder={`Search ${label.toLocaleLowerCase()}…`}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                aria-label={`Filter ${label.toLocaleLowerCase()}`}
              />
            }
          >
            <FilterIcon /> Filters{hasFilters ? " · On" : ""}
          </MenuTrigger>
          <MenuPopup align="end" className="w-44">
            <MenuGroupLabel>Assignment</MenuGroupLabel>
            <MenuRadioGroup
              value={assignment}
              onValueChange={(value) => setAssignment(value as AssignmentFilter)}
            >
              <MenuRadioItem value="all">All</MenuRadioItem>
              <MenuRadioItem value="selected">Selected</MenuRadioItem>
              <MenuRadioItem value="unselected">Unselected</MenuRadioItem>
            </MenuRadioGroup>
            {showStatusFilter ? (
              <>
                <MenuSeparator />
                <MenuGroupLabel>Member state</MenuGroupLabel>
                <MenuRadioGroup
                  value={status}
                  onValueChange={(value) => setStatus(value as AssignmentStatusFilter)}
                >
                  <MenuRadioItem value="all">All states</MenuRadioItem>
                  <MenuRadioItem value="active">Active</MenuRadioItem>
                  <MenuRadioItem value="locked">Locked</MenuRadioItem>
                  <MenuRadioItem value="left">Left</MenuRadioItem>
                </MenuRadioGroup>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span id={`${id}-status`} aria-live="polite" aria-atomic="true">
          {summary.visible} {summary.visible === 1 ? "result" : "results"} · {summary.selected}{" "}
          selected
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={blocked || summary.addIds.length === 0 || summary.addOverLimit}
            title={
              summary.addOverLimit
                ? "Narrow the search or filters to 500 changes or fewer."
                : undefined
            }
            onClick={() => onVisibleChange({ addIds: summary.addIds, removeIds: [] })}
          >
            Select visible
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={blocked || summary.removeIds.length === 0 || summary.removeOverLimit}
            title={
              summary.removeOverLimit
                ? "Narrow the search or filters to 500 changes or fewer."
                : undefined
            }
            onClick={() => onVisibleChange({ addIds: [], removeIds: summary.removeIds })}
          >
            Clear visible
          </Button>
        </div>
      </div>
      {summary.addOverLimit || summary.removeOverLimit ? (
        <p className="text-[11px] text-warning" role="status">
          Narrow the search or filters to change no more than 500 assignments at once.
        </p>
      ) : null}

      {visibleItems.length === 0 ? (
        <div className="rounded-lg border border-dashed p-5 text-center">
          <p className="text-xs font-medium">No matching results</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Try another search or reset the filters.
          </p>
          <Button type="button" size="xs" variant="outline" className="mt-3" onClick={reset}>
            Reset search and filters
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border" aria-describedby={`${id}-status`}>
          <LegendList<CompanyAssignmentPickerItem<Id>>
            data={visibleItems}
            estimatedItemSize={ROW_HEIGHT}
            extraData={items}
            keyExtractor={(item) => item.id}
            role="list"
            style={{ height: Math.min(visibleItems.length * ROW_HEIGHT, MAX_LIST_HEIGHT) }}
            renderItem={({ item }) => {
              const itemDisabled = item.selected ? !item.mayRemove : !item.mayAdd;
              const reason = itemDisabled ? item.disabledReason : undefined;
              return (
                <label
                  className="flex h-[58px] w-full items-center gap-3 border-b px-3 last:border-b-0 has-data-disabled:bg-muted/35"
                  title={reason}
                >
                  <Checkbox
                    aria-label={`${item.selected ? "Remove" : "Add"} ${item.primaryLabel}`}
                    checked={item.selected}
                    disabled={itemDisabled}
                    onCheckedChange={(checked) => onToggle(item.id, checked === true)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium">{item.primaryLabel}</span>
                      {item.statusLabel ? (
                        <Badge
                          variant={
                            item.status === "archived" || item.status === "locked"
                              ? "warning"
                              : "secondary"
                          }
                        >
                          {item.statusLabel}
                        </Badge>
                      ) : null}
                    </span>
                    {item.secondaryLabel ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {item.secondaryLabel}
                      </span>
                    ) : null}
                    {reason ? (
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {reason}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            }}
          />
        </div>
      )}
    </fieldset>
  );
}
