interface AnnotationChromeEvent {
  readonly type: string;
  preventDefault(): void;
  stopPropagation(): void;
}

export function isolateAnnotationChromeEvent(
  event: AnnotationChromeEvent,
  preservePageFocus: boolean,
): void {
  if (preservePageFocus && event.type === "mousedown") event.preventDefault();
  event.stopPropagation();
}
