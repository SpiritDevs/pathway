export type FocusSwipeDirection = -1 | 1;

/** Wheel events have no gesture-end signal; a quiet gap releases the axis and momentum lock. */
export function createFocusSwipeHandler(onSwipe: (direction: FocusSwipeDirection) => void) {
  let lastEventAt = -Infinity;
  let distanceX = 0;
  let distanceY = 0;
  let axis: "horizontal" | "vertical" | null = null;
  let switched = false;

  return (event: WheelEvent) => {
    if (event.timeStamp - lastEventAt > 200) {
      distanceX = 0;
      distanceY = 0;
      axis = null;
      switched = false;
    }
    lastEventAt = event.timeStamp;

    // Trackpads send pixel deltas. Leave zoom and modified mouse-wheel gestures alone.
    if (
      event.defaultPrevented ||
      event.deltaMode !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    ) {
      axis = "vertical";
      return;
    }

    distanceX += event.deltaX;
    distanceY += event.deltaY;
    if (axis === null && Math.max(Math.abs(distanceX), Math.abs(distanceY)) >= 8) {
      axis = Math.abs(distanceX) > Math.abs(distanceY) * 1.5 ? "horizontal" : "vertical";
    }
    if (axis !== "horizontal") return;

    // Claim the whole horizontal gesture, including its momentum, before browser history does.
    event.preventDefault();
    if (!switched && Math.abs(distanceX) >= 60) {
      switched = true;
      onSwipe(distanceX > 0 ? 1 : -1);
    }
  };
}
