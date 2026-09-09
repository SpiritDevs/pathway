import { nextFocusId, type ActiveFocusId } from "@spiritdevs/client-runtime/state/focuses";
import type { Focus } from "@spiritdevs/contracts/focus";
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";

import { createFocusSwipeHandler, type FocusSwipeDirection } from "./focusSwipe";

/** Attach only to the thread-list viewport, leaving the header and focus strip scrollable. */
export function useFocusSwipe(input: {
  readonly hasConversations?: boolean;
  readonly activeFocusId: ActiveFocusId;
  readonly visibleFocuses: ReadonlyArray<Pick<Focus, "id">>;
  readonly onActiveFocusChange: (id: ActiveFocusId) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingSlide = useRef<{
    focusId: ActiveFocusId;
    direction: FocusSwipeDirection;
  } | null>(null);
  const enabled = input.visibleFocuses.length > 0 || input.hasConversations === true;

  const selectAdjacentFocus = useEffectEvent((direction: FocusSwipeDirection) => {
    const focusId = nextFocusId({ ...input, direction });
    if (focusId === input.activeFocusId) return;
    pendingSlide.current = { focusId, direction };
    input.onActiveFocusChange(focusId);
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !enabled) return;
    const handleWheel = createFocusSwipeHandler(selectAdjacentFocus);
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [enabled]);

  useLayoutEffect(() => {
    const slide = pendingSlide.current;
    pendingSlide.current = null;
    const content = contentRef.current;
    if (
      !slide ||
      slide.focusId !== input.activeFocusId ||
      !content ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const animation = content.animate(
      [
        { transform: `translateX(${slide.direction * 100}%)`, opacity: 0.6 },
        { transform: "translateX(0)", opacity: 1 },
      ],
      { duration: 180, easing: "ease-out" },
    );
    return () => animation.cancel();
  }, [input.activeFocusId]);

  return { viewportRef, contentRef };
}
