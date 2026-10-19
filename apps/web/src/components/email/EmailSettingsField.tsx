/**
 * The text field capture settings are edited through.
 *
 * Capture settings are a server document, not client preferences: a keystroke cannot be the write,
 * and the write can be refused (a taken port, a slug another project owns). So the field holds a
 * draft while it is being typed in, commits on blur or Enter, validates before sending, and keeps
 * the draft when the server says no — while an edit made elsewhere still lands the moment this one
 * is not mid-edit.
 *
 * @module components/email/EmailSettingsField
 */
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Input } from "../ui/input";

export function EmailSettingField({
  ariaLabel,
  value,
  placeholder,
  className,
  disabled = false,
  inputMode,
  validate,
  onCommit,
}: {
  ariaLabel: string;
  /** The committed value, from the settings document. */
  value: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  inputMode?: "numeric" | "text";
  /** The reason this draft cannot be sent, or null. Blocks the commit and shows under the field. */
  validate?: (draft: string) => string | null;
  /** Resolves true when the write landed, which is what clears the draft. */
  onCommit: (draft: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const text = draft ?? value;
  const error = draft === null ? null : (validate?.(draft) ?? null);

  const commit = async () => {
    if (draft === null || saving) return;
    if (draft === value) {
      setDraft(null);
      return;
    }
    if (error !== null) return;
    setSaving(true);
    const accepted = await onCommit(draft);
    setSaving(false);
    if (accepted) setDraft(null);
  };

  return (
    <div className={cn("flex w-full flex-col gap-1 sm:w-64", className)}>
      <Input
        aria-invalid={error !== null}
        aria-label={ariaLabel}
        className={cn(error !== null && "border-destructive")}
        disabled={disabled || saving}
        inputMode={inputMode}
        onBlur={() => void commit()}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
          }
        }}
        placeholder={placeholder}
        value={text}
      />
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
