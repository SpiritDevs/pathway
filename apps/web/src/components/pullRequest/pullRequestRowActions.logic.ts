/** Keyboard context-menu events may have no pointer coordinates. Place them beside the row. */
export function pullRequestRowMenuPosition(event: {
  clientX: number;
  clientY: number;
  currentTarget: { getBoundingClientRect: () => Pick<DOMRect, "left" | "bottom"> };
}) {
  if (event.clientX !== 0 || event.clientY !== 0) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}
