import { create } from "zustand";

/**
 * Built-in browser dialogs that open from both Settings → Browser and the
 * preview's More menu. {@link BrowserDialogsHost} renders whichever is open.
 */
export type BrowserDialog = "clear-data" | "import";

export const useBrowserDialogStore = create<{ readonly open: BrowserDialog | null }>(() => ({
  open: null,
}));

export function openBrowserDialog(dialog: BrowserDialog): void {
  useBrowserDialogStore.setState({ open: dialog });
}

export function closeBrowserDialog(): void {
  useBrowserDialogStore.setState({ open: null });
}
