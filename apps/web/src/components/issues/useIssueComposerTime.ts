import { useEffect, useRef } from "react";
import type { FocusEvent } from "react";
import { createIssueComposerClock } from "./issueComposerTime";

/** Measures foreground interaction without rendering or writing on every keystroke. */
export function useIssueComposerTime(open: boolean, submitting: boolean) {
  const clock = useRef(createIssueComposerClock());

  useEffect(() => {
    if (!open) clock.current.reset();
  }, [open]);

  useEffect(() => {
    if (!open || submitting) {
      clock.current.pause(Date.now());
      return;
    }
    const pause = () => clock.current.pause(Date.now());
    const visibilityChanged = () => {
      if (document.hidden) pause();
    };
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      pause();
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [open, submitting]);

  const activity = () => {
    if (open && !submitting && !document.hidden) clock.current.activity(Date.now());
  };

  return {
    capture: () => clock.current.snapshot(Date.now()),
    reset: () => clock.current.reset(),
    interactionProps: {
      onFocusCapture: activity,
      onKeyDownCapture: activity,
      onPointerDownCapture: activity,
      onBlurCapture: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) clock.current.pause(Date.now());
      },
    },
  };
}
