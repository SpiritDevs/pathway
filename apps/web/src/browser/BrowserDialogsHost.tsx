import { BrowserImportDialog } from "./BrowserImportDialog";
import { closeBrowserDialog, useBrowserDialogStore } from "./browserDialogs";
import { ClearBrowsingDataDialog } from "./ClearBrowsingDataDialog";

/** Renders the built-in browser dialog opened from Settings or the preview menu. */
export function BrowserDialogsHost() {
  const open = useBrowserDialogStore((state) => state.open);
  const onOpenChange = (next: boolean) => {
    if (!next) closeBrowserDialog();
  };
  return (
    <>
      <ClearBrowsingDataDialog open={open === "clear-data"} onOpenChange={onOpenChange} />
      {/* Mounted only while open, so its browser and profile lookups run on demand. */}
      {open === "import" ? <BrowserImportDialog open onOpenChange={onOpenChange} /> : null}
    </>
  );
}
