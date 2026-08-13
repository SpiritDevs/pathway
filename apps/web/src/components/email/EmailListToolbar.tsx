/**
 * The bar above the message list: select-all, the inbox's name and count, search, quick filters,
 * and mark-all-read.
 *
 * The search field is revealed rather than always mounted, because the pane is 352px by default
 * and a permanent input costs a row the messages want. Closing it clears the query for the same
 * reason a hidden filter is a bug: the list must never be narrowed by something nobody can see.
 *
 * @module components/email/EmailListToolbar
 */
import { ListFilterIcon, MailOpenIcon, SearchIcon, XIcon } from "lucide-react";
import { useId, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import {
  EMAIL_FILTER_FIELDS,
  EMAIL_FILTER_FIELD_LABELS,
  EMAIL_FILTER_FIELD_VALUES,
  NO_EMAIL_LIST_FILTER,
  emailFilterValueLabel,
  emailFilterValues,
  emailListFilterCount,
  emailMessageCountLabel,
  isEmailListFilterActive,
  toggleEmailFilterValue,
  type EmailFilterField,
  type EmailFilterValue,
  type EmailListFilter,
  type EmailSelectAllState,
} from "./emailList.logic";

export function EmailListToolbar({
  inboxName,
  visibleCount,
  totalCount,
  selectAllState,
  onToggleSelectAll,
  query,
  onQuery,
  searchOpen,
  onSearchOpen,
  filter,
  onFilter,
  isPending,
  unreadCount,
  onMarkAllRead,
}: {
  inboxName: string;
  visibleCount: number;
  totalCount: number;
  selectAllState: EmailSelectAllState;
  onToggleSelectAll: () => void;
  query: string;
  onQuery: (query: string) => void;
  searchOpen: boolean;
  onSearchOpen: (open: boolean) => void;
  filter: EmailListFilter;
  onFilter: (filter: EmailListFilter) => void;
  isPending: boolean;
  unreadCount: number;
  onMarkAllRead: () => void;
}) {
  const searchId = useId();
  const filterCount = emailListFilterCount(filter);

  const closeSearch = () => {
    onQuery("");
    onSearchOpen(false);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeSearch();
  };

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-2 px-3 py-1.5">
        {totalCount === 0 ? null : (
          <Checkbox
            aria-label={
              visibleCount === 0
                ? "No messages available to select"
                : selectAllState === "all"
                  ? "Clear the selection"
                  : "Select all shown messages"
            }
            checked={selectAllState === "all"}
            className="size-3.5 shrink-0 sm:size-3.5"
            disabled={visibleCount === 0}
            indeterminate={selectAllState === "partial"}
            onCheckedChange={onToggleSelectAll}
          />
        )}
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{inboxName}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
          {emailMessageCountLabel(visibleCount, totalCount)}
        </span>

        <span className="ms-auto flex shrink-0 items-center gap-0.5">
          {isPending ? <Spinner className="size-3" /> : null}

          <Button
            aria-controls={searchOpen ? searchId : undefined}
            aria-expanded={searchOpen}
            aria-label={searchOpen ? "Close message search" : "Search messages"}
            onClick={() => (searchOpen ? closeSearch() : onSearchOpen(true))}
            size="icon-xs"
            title={searchOpen ? "Close search" : "Search messages"}
            variant="ghost"
          >
            <SearchIcon />
          </Button>

          <EmailFilterMenu filter={filter} onChange={onFilter} />

          {unreadCount > 0 ? (
            <Button
              aria-label={`Mark all ${unreadCount} unread messages read`}
              className="h-6 px-1.5 text-xs"
              onClick={onMarkAllRead}
              size="xs"
              title="Mark all read"
              variant="ghost"
            >
              <MailOpenIcon aria-hidden="true" />
              Mark all read
            </Button>
          ) : null}
        </span>
      </div>

      {searchOpen ? (
        <div className="px-3 pb-1.5">
          <Input
            aria-label="Search messages"
            /* The reveal is the deliberate act; landing focus anywhere else would make it a
               two-press affordance. */
            autoFocus
            id={searchId}
            onKeyDown={onSearchKeyDown}
            onValueChange={onQuery}
            placeholder="Sender, subject, body, code…"
            size="sm"
            type="search"
            value={query}
          />
        </div>
      ) : null}

      {filterCount === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5">
          {EMAIL_FILTER_FIELDS.flatMap((field) =>
            emailFilterValues(filter, field).map((value) => (
              <button
                aria-label={`Remove the ${emailFilterValueLabel(field, value)} filter`}
                className="flex h-5 items-center gap-1 rounded-md border border-border/60 ps-1.5 pe-1 text-[11px] text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                key={`${field}:${value}`}
                onClick={() => onFilter(toggleEmailFilterValue(filter, field, value))}
                type="button"
              >
                {emailFilterValueLabel(field, value)}
                <XIcon aria-hidden="true" className="size-2.5 text-muted-foreground" />
              </button>
            )),
          )}
          <button
            className="flex h-5 items-center rounded-md px-1.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onFilter(NO_EMAIL_LIST_FILTER)}
            type="button"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The quick-filter control.
 *
 * A `Popover` of checkbox rows rather than the tracker's chip-per-field bar: the model is the same
 * (OR inside a field, AND across them) but this list lives in a pane that resizes down to 240px,
 * where three chips would wrap onto three rows. It is a `Popover` for the reason the tracker's
 * chips are — a `Menu` would swallow the first keystroke as typeahead.
 */
export function EmailFilterMenu({
  filter,
  onChange,
}: {
  filter: EmailListFilter;
  onChange: (filter: EmailListFilter) => void;
}) {
  const count = emailListFilterCount(filter);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={count === 0 ? "Filter messages" : `Filter messages, ${count} active`}
            className={cn(count === 0 ? null : "text-primary")}
            size="icon-xs"
            title="Filter messages"
            variant="ghost"
          >
            <ListFilterIcon />
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-56 p-1.5" side="bottom">
        <div aria-label="Message filters" role="group">
          {EMAIL_FILTER_FIELDS.map((field) => (
            <EmailFilterGroup field={field} filter={filter} key={field} onChange={onChange} />
          ))}
        </div>
        {isEmailListFilterActive(filter) ? (
          <button
            className="mt-1 flex h-6 w-full items-center rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onChange(NO_EMAIL_LIST_FILTER)}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function EmailFilterGroup({
  field,
  filter,
  onChange,
}: {
  field: EmailFilterField;
  filter: EmailListFilter;
  onChange: (filter: EmailListFilter) => void;
}) {
  const values = emailFilterValues(filter, field);

  return (
    <div className="mb-1 last:mb-0">
      <p className="px-1.5 py-1 text-[11px] font-medium text-muted-foreground">
        {EMAIL_FILTER_FIELD_LABELS[field]}
      </p>
      {EMAIL_FILTER_FIELD_VALUES[field].map((value: EmailFilterValue) => {
        const checked = values.includes(value);
        return (
          <button
            aria-checked={checked}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px] outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
            key={value}
            onClick={() => onChange(toggleEmailFilterValue(filter, field, value))}
            role="checkbox"
            type="button"
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
              )}
            >
              {checked ? (
                <svg
                  className="size-2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="3"
                  viewBox="0 0 24 24"
                >
                  <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
                </svg>
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{emailFilterValueLabel(field, value)}</span>
          </button>
        );
      })}
    </div>
  );
}
