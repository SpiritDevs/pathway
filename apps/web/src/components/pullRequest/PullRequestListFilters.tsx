import type {
  PullRequestInvolvement,
  PullRequestListState,
  SourceControlProviderKind,
} from "@spiritdevs/contracts";
import { ListFilterIcon, LoaderIcon, SearchIcon } from "lucide-react";
import type { ElementType } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export interface PullRequestFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /**
   * Carries the option's own tone, so an icon reads the same here as it does on a row. Left
   * uncoloured, which lets the item's selected state stay the thing the eye follows.
   */
  readonly Icon: ElementType<{ className?: string }>;
  /** Why it cannot be chosen, carried onto the item as its title. */
  readonly unavailable?: string | undefined;
}

export interface PullRequestExpectedHost {
  readonly host: string;
  readonly kind: SourceControlProviderKind;
}

/**
 * What to call a host in the row. The provider's own name reads best — "GitHub" over
 * "github.com" — but it stops naming anything once a workspace has two hosts of one kind, so
 * those wear the host itself instead. Only the ambiguous ones: a lone GitLab beside two GitHub
 * installs is still "GitLab".
 */
export function pullRequestHostLabel(
  entries: ReadonlyArray<{ readonly host: string; readonly kind: SourceControlProviderKind }>,
  entry: { readonly host: string; readonly kind: SourceControlProviderKind },
): string {
  const sharing = entries.filter((candidate) => candidate.kind === entry.kind);
  return sharing.length > 1
    ? entry.host
    : getSourceControlPresentationForKind(entry.kind).providerName;
}

export function PullRequestSearchInput({
  value,
  busy,
  onChange,
}: {
  value: string;
  /** A search is on its way to the hosts, said where the typing is rather than over the list. */
  busy?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      {busy ? (
        <LoaderIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
        />
      ) : (
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
      )}
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Search pull requests"
        aria-label="Search pull requests"
        // Tracks the shared input's height at both widths, so it stays level with the icon
        // button beside it rather than towering over it on wide screens.
        className="h-9 w-full rounded-lg border border-input bg-background pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 sm:h-8"
      />
    </div>
  );
}

/**
 * Every list filter lives behind the one filter icon so the control row stays two controls
 * wide: the search and this. The trigger carries a dot whenever any filter is off its
 * default, so a narrowed list is never a mystery. Same menu chrome as the detail panel's
 * actions, which also owns its own spacing.
 */
/** MenuRadioGroup wants a string, so "every host" wears the one value no host can be. */
const ALL_HOSTS_VALUE = "";

function PullRequestFilterRadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next as Value);
      }}
    >
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {options.map((option) => (
        <MenuRadioItem
          key={option.value}
          value={option.value}
          // A host the server has already said it cannot read is not a choice here: offering
          // it would answer the press by replacing a working list with that failure.
          disabled={option.unavailable !== undefined}
          title={option.unavailable}
        >
          <span className="flex min-w-0 items-center gap-2">
            <option.Icon aria-hidden className="size-3.5" />
            {option.label}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

export function PullRequestFiltersMenu({
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  host,
  hostOptions,
  onHost,
}: {
  state: PullRequestListState;
  stateOptions: ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;
  onState: (state: PullRequestListState) => void;
  involvement: PullRequestInvolvement;
  involvementOptions: ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  host: string | undefined;
  /**
   * Includes the "all hosts" entry, whose value is the empty string. With fewer than two real
   * hosts there is nothing to switch between, so the whole group stays out of the menu.
   */
  hostOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onHost: (host: string | undefined) => void;
}) {
  const filtered = state !== "open" || involvement !== "all" || host !== undefined;
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          // The icon-button size that pairs with a full-height input, so the two read as one strip.
          "relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground sm:size-8",
          filtered && "text-foreground",
        )}
        aria-label="Filter pull requests"
      >
        <ListFilterIcon className="size-4" />
        {filtered ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-56">
        <PullRequestFilterRadioGroup
          label="State"
          value={state}
          options={stateOptions}
          onChange={onState}
        />
        <MenuSeparator />
        <PullRequestFilterRadioGroup
          label="Involvement"
          value={involvement}
          options={involvementOptions}
          onChange={onInvolvement}
        />
        {hostOptions.length > 2 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioGroup
              label="Host"
              value={host ?? ALL_HOSTS_VALUE}
              options={hostOptions}
              onChange={(next) => onHost(next === ALL_HOSTS_VALUE ? undefined : next)}
            />
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
