/**
 * The filter chip bar under the `/issues` tabs.
 *
 * One chip per active field, OR inside a chip and AND across them — the decision record's whole
 * filter model, with no nesting and no negation. Every chip is a `Popover` rather than a `Menu`
 * for the reason the label editor already is: three of them host a search box, and a menu treats
 * the first keystroke as typeahead.
 *
 * @module components/issues/IssuesFilterBar
 */
import type {
  IssueAssignee,
  IssueCycle,
  IssueLabel,
  IssueMilestone,
  IssueStatus,
} from "@spiritdevs/contracts";
import { CheckIcon, ListFilterIcon, PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  IssueAssigneeGlyph,
  IssueLabelDot,
  IssuePriorityIcon,
  IssueStatusDot,
} from "./IssueGlyphs";
import {
  ISSUES_FILTER_FIELDS,
  ISSUES_FILTER_FIELD_LABELS,
  ISSUE_DUE_FILTER_LABELS,
  ISSUE_PRIORITY_LABELS,
  ISSUE_PRIORITY_ORDER,
  ISSUE_VIEW_DUE_FILTERS,
  NO_ISSUES_LIST_FILTER,
  activeIssuesFilterFields,
  filterIssuesFilterOptions,
  isIssuesListFilterActive,
  issuesFilterValueLabels,
  issuesFilterValues,
  summarizeIssuesFilterValues,
  withIssuesFilterValues,
  type IssuesFilterField,
  type IssuesListFilter,
} from "./issuesList.logic";
import type { IssueProjectOption } from "./useIssueProjectOptions";

/** The three fields whose list can run to dozens of rows; the other five never do. */
const SEARCHABLE_FIELDS: ReadonlySet<IssuesFilterField> = new Set([
  "project",
  "label",
  "milestone",
]);

interface FilterOption {
  readonly value: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly aliases?: ReadonlyArray<string>;
}

type FilterOptions = Readonly<Record<IssuesFilterField, ReadonlyArray<FilterOption>>>;

export interface IssuesFilterBarProps {
  readonly filter: IssuesListFilter;
  readonly onChange: (filter: IssuesListFilter) => void;
  readonly statuses: ReadonlyArray<IssueStatus>;
  readonly projects: ReadonlyArray<IssueProjectOption>;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly milestones: ReadonlyArray<IssueMilestone>;
  readonly cycles: ReadonlyArray<IssueCycle>;
  /**
   * Every assignee the tracker can hold, in menu order. Unassigned is deliberately absent:
   * `IssueViewConfig.assignees` is a list of real assignees, so a chip for "nobody" could be
   * built here and never saved as a view.
   */
  readonly assigneeOptions: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly assignee: IssueAssignee;
  }>;
  /**
   * Rendered after the chips, on the same wrapping row. The save-view affordance lives here rather
   * than in the header because what it saves is this bar, and a control that appears a row away
   * from the thing it names reads as belonging to the page instead.
   */
  readonly actions?: ReactNode;
  readonly className?: string;
}

export function IssuesFilterBar({
  filter,
  onChange,
  statuses,
  projects,
  labels,
  milestones,
  cycles,
  assigneeOptions,
  actions,
  className,
}: IssuesFilterBarProps) {
  // A field the "+ Filter" menu just added has no values yet, so nothing else knows it is on the
  // bar. It stays here until it is given one or its popover closes empty.
  const [pendingFields, setPendingFields] = useState<ReadonlyArray<IssuesFilterField>>([]);
  const [openField, setOpenField] = useState<IssuesFilterField | null>(null);

  const options = useMemo<FilterOptions>(() => {
    const projectTitles = new Map(
      projects.flatMap((project) =>
        project.projectIds.map((projectId) => [projectId as string, project.title] as const),
      ),
    );
    return {
      status: statuses.map((status) => ({
        value: status.id,
        label: status.name,
        icon: <IssueStatusDot status={status} />,
      })),
      project: projects.map((project) => ({
        value: project.id,
        label: project.title,
        aliases: project.projectIds,
      })),
      label: labels.map((label) => ({
        value: label.id,
        label: label.name,
        icon: <IssueLabelDot color={label.color} />,
      })),
      // Milestone names repeat across projects ("v1"), so the project is part of the name here.
      milestone: milestones.map((milestone) => {
        const project = projectTitles.get(milestone.projectId);
        return {
          value: milestone.id,
          label: project === undefined ? milestone.name : `${project} · ${milestone.name}`,
        };
      }),
      cycle: cycles.map((cycle) => ({ value: cycle.id, label: cycle.name })),
      assignee: assigneeOptions.map((option) => ({
        value: option.value,
        label: option.label,
        icon: (
          <IssueAssigneeGlyph assignee={option.assignee} className="size-4" label={option.label} />
        ),
      })),
      priority: ISSUE_PRIORITY_ORDER.map((priority) => ({
        value: priority,
        label: ISSUE_PRIORITY_LABELS[priority],
        icon: <IssuePriorityIcon priority={priority} />,
      })),
      due: ISSUE_VIEW_DUE_FILTERS.map((due) => ({
        value: due,
        label: ISSUE_DUE_FILTER_LABELS[due],
      })),
    };
  }, [assigneeOptions, cycles, labels, milestones, projects, statuses]);

  const activeFields = activeIssuesFilterFields(filter);
  const shownFields = ISSUES_FILTER_FIELDS.filter(
    (field) => activeFields.includes(field) || pendingFields.includes(field),
  );
  const addableFields = ISSUES_FILTER_FIELDS.filter((field) => !shownFields.includes(field));

  const dropPending = (field: IssuesFilterField) => {
    setPendingFields((current) => current.filter((entry) => entry !== field));
  };

  const removeField = (field: IssuesFilterField) => {
    if (openField === field) setOpenField(null);
    dropPending(field);
    onChange(withIssuesFilterValues(filter, field, []));
  };

  const clearAll = () => {
    setOpenField(null);
    setPendingFields([]);
    onChange(NO_ISSUES_LIST_FILTER);
  };

  return (
    <div
      aria-label="Issue filters"
      className={cn("flex flex-wrap items-center gap-1", className)}
      role="group"
    >
      {shownFields.map((field) => (
        <FilterChip
          field={field}
          filter={filter}
          key={field}
          onChange={onChange}
          onOpenChange={(open) => {
            setOpenField(open ? field : null);
            if (!open && issuesFilterValues(filter, field).length === 0) dropPending(field);
          }}
          onRemove={() => removeField(field)}
          open={openField === field}
          options={options[field]}
        />
      ))}

      {addableFields.length === 0 ? null : (
        <Menu>
          <MenuTrigger
            render={
              <button
                className="flex h-6 items-center gap-1 rounded-md border border-dashed border-border/70 px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              >
                <PlusIcon className="size-3" />
                Filter
              </button>
            }
          />
          <MenuPopup align="start" className="min-w-44" side="bottom">
            <MenuGroup>
              <MenuGroupLabel>Filter by</MenuGroupLabel>
              {addableFields.map((field) => (
                <MenuItem
                  closeOnClick
                  key={field}
                  onClick={() => {
                    setPendingFields((current) => [...current, field]);
                    setOpenField(field);
                  }}
                >
                  {ISSUES_FILTER_FIELD_LABELS[field]}
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      )}

      {isIssuesListFilterActive(filter) ? (
        <button
          className="flex h-6 items-center rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={clearAll}
          type="button"
        >
          Clear
        </button>
      ) : null}

      {actions === undefined ? null : <div className="ms-auto flex items-center">{actions}</div>}
    </div>
  );
}

function FilterChip({
  field,
  filter,
  options,
  open,
  onOpenChange,
  onChange,
  onRemove,
}: {
  field: IssuesFilterField;
  filter: IssuesListFilter;
  options: ReadonlyArray<FilterOption>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (filter: IssuesListFilter) => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState("");
  const fieldLabel = ISSUES_FILTER_FIELD_LABELS[field];
  const values = issuesFilterValues(filter, field);
  const knownValues = new Set(options.flatMap((option) => option.aliases ?? [option.value]));
  const selectedLabels = options
    .filter((option) => (option.aliases ?? [option.value]).some((value) => values.includes(value)))
    .map((option) => option.label);
  const summary = summarizeIssuesFilterValues([
    ...selectedLabels,
    ...issuesFilterValueLabels(
      values.filter((value) => !knownValues.has(value)),
      [],
    ),
  ]);
  const searchable = SEARCHABLE_FIELDS.has(field) && options.length > 0;
  const visible = searchable ? filterIssuesFilterOptions(options, query) : options;

  return (
    <span className="flex h-6 items-center rounded-md border border-border/60 bg-background text-xs">
      <Popover
        onOpenChange={(next) => {
          if (!next) setQuery("");
          onOpenChange(next);
        }}
        open={open}
      >
        <PopoverTrigger
          render={
            <button
              className="flex h-6 max-w-56 items-center gap-1 rounded-s-md ps-2 pe-1.5 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              <ListFilterIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">{fieldLabel}</span>
              <span className="truncate text-foreground">{summary}</span>
            </button>
          }
        />
        <PopoverPopup align="start" className="w-60 p-1.5" side="bottom">
          {searchable ? (
            <Input
              aria-label={`Search ${fieldLabel.toLowerCase()}s`}
              autoFocus
              className="mb-1"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={`Search ${fieldLabel.toLowerCase()}s…`}
              size="sm"
              value={query}
            />
          ) : null}
          <div className="max-h-64 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">
                {options.length === 0 ? `No ${fieldLabel.toLowerCase()}s yet.` : "No matches."}
              </p>
            ) : (
              visible.map((option) => {
                const optionValues = option.aliases ?? [option.value];
                const checked = optionValues.every((value) => values.includes(value));
                return (
                  <button
                    aria-checked={checked}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px] outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                    key={option.value}
                    onClick={() =>
                      onChange(
                        withIssuesFilterValues(
                          filter,
                          field,
                          checked
                            ? values.filter((value) => !optionValues.includes(value))
                            : [...values, ...optionValues],
                        ),
                      )
                    }
                    role="checkbox"
                    type="button"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border",
                      )}
                    >
                      {checked ? <CheckIcon className="size-2.5" /> : null}
                    </span>
                    {option.icon}
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </PopoverPopup>
      </Popover>
      <button
        aria-label={`Remove the ${fieldLabel.toLowerCase()} filter`}
        className="flex h-6 items-center rounded-e-md border-s border-border/60 px-1 text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onRemove}
        type="button"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}
