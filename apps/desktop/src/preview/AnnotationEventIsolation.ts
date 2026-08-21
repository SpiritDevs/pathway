interface AnnotationChromeEvent {
  readonly type: string;
  preventDefault(): void;
  stopPropagation(): void;
}

interface AnnotationChromeFocusTarget {
  focus(options?: FocusOptions): void;
}

export function isolateAnnotationChromeEvent(
  event: AnnotationChromeEvent,
  preservePageFocus: boolean,
  focusTarget: AnnotationChromeFocusTarget | null = null,
): void {
  if (event.type === "pointerdown") focusTarget?.focus({ preventScroll: true });
  if (preservePageFocus && event.type === "mousedown") event.preventDefault();
  event.stopPropagation();
}
