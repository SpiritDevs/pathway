import { type ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The survey answer control. Deliberately a plain toggle button rather than
 * `components/ui/toggle-group`: that primitive is a segmented control with
 * merged borders, and these answers read as a wrapping row of independent
 * pills. `aria-pressed` carries the state for both the single- and
 * multi-select rows.
 */
export function OptionChip({
  children,
  disabled = false,
  onPress,
  selected,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "cursor-pointer rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-foreground hover:bg-accent/50",
      )}
      disabled={disabled}
      onClick={onPress}
      type="button"
    >
      {children}
    </button>
  );
}

export function OptionChipGroup({
  children,
  hint,
  label,
}: {
  readonly children: ReactNode;
  readonly hint?: string;
  readonly label: string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-foreground">{label}</legend>
      {hint === undefined ? null : <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-2.5 flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}
