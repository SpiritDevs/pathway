import { type ChangeEvent, type KeyboardEvent, useRef, useState } from "react";

type CommitOnBlurElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * Buffer text input locally so keystrokes don't cause a settings-wide
 * re-render (and optionally a server RPC round-trip) on every character.
 * `onCommit` fires on blur and on Enter; Escape abandons the draft.
 *
 * The draft resynchronizes from the upstream `value` only when the input
 * is not focused, so an external push (e.g. an optimistic settings
 * update from the user's own commit, or a reset to defaults) doesn't
 * clobber an in-progress edit.
 *
 * Returns a bag of props that should be spread onto an `<Input>`:
 *
 *   const bag = useCommitOnBlur(instance.displayName ?? "", (next) => {...});
 *   <Input {...bag} placeholder="e.g. Work" />
 *
 * Pass the element type for a `<Textarea>`, whose event types differ:
 *
 *   const bag = useCommitOnBlur<HTMLTextAreaElement>(issue.title, commitTitle);
 */
export function useCommitOnBlur<E extends CommitOnBlurElement = HTMLInputElement>(
  value: string,
  onCommit: (next: string) => void,
) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs, and `.blur()` runs the blur handler synchronously against this render's
  // `draft`, so the cancellation has to travel in something a state update cannot lose the race to.
  const cancelledRef = useRef(false);

  return {
    value: draft ?? value,
    onChange: (event: ChangeEvent<E>) => {
      setDraft(event.target.value);
    },
    onFocus: () => {
      setDraft(value);
    },
    onBlur: () => {
      const next = draft ?? value;
      setDraft(null);
      if (cancelledRef.current) {
        cancelledRef.current = false;
        return;
      }
      if (next !== value) {
        onCommit(next);
      }
    },
    onKeyDown: (event: KeyboardEvent<E>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        cancelledRef.current = true;
        event.currentTarget.blur();
      }
    },
  };
}
