import { createContext, use } from "react";
import type { ChatComposerHandle } from "./components/chat/ChatComposer";

export type ComposerHandleRef = React.RefObject<ChatComposerHandle | null> & {
  /** Mount a collapsed, messageable composer's handle before an explicit action. */
  reveal?: () => void;
};

export function resolveComposerHandle<T>(
  ref: React.RefObject<T | null> & { reveal?: () => void },
): T | null {
  if (ref.current === null) ref.reveal?.();
  return ref.current;
}

/** Let the dialog restore its trigger when the composer is collapsed. */
export function focusComposerOnDialogClose(handle: Pick<ChatComposerHandle, "focusAtEnd"> | null) {
  if (handle === null) return true;
  handle.focusAtEnd();
  return false;
}

export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null);

export function useComposerHandleContext(): ComposerHandleRef | null {
  return use(ComposerHandleContext);
}
