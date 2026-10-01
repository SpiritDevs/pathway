import type { EnvironmentId, ThreadId } from "@spiritdevs/contracts";

const THREAD_PARENT_PICKER_EVENT = "pathway:open-thread-parent-picker";

export interface ThreadParentPickerTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Opens the "Set parent" picker for a thread from any surface. */
export function openThreadParentPicker(target: ThreadParentPickerTarget): void {
  window.dispatchEvent(new CustomEvent(THREAD_PARENT_PICKER_EVENT, { detail: target }));
}

export function onOpenThreadParentPicker(
  listener: (target: ThreadParentPickerTarget) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<ThreadParentPickerTarget>).detail);
  };
  window.addEventListener(THREAD_PARENT_PICKER_EVENT, handler);
  return () => window.removeEventListener(THREAD_PARENT_PICKER_EVENT, handler);
}
