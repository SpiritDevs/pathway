import type { DesktopBrowserClearDataInput } from "@spiritdevs/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { useBrowserHistoryStore } from "~/browserHistoryStore";

type ClearChoices = DesktopBrowserClearDataInput & { readonly history: boolean };

const CLEAR_OPTIONS: ReadonlyArray<{ readonly key: keyof ClearChoices; readonly label: string }> = [
  { key: "history", label: "Browsing history" },
  { key: "cookies", label: "Cookies" },
  { key: "siteData", label: "Site data" },
  { key: "cache", label: "Cached images and files" },
  { key: "downloads", label: "Download history" },
];

const ALL_CHOICES: ClearChoices = {
  history: true,
  cookies: true,
  siteData: true,
  cache: true,
  downloads: true,
};

/** Clears the built-in browser's data. History lives in this client; the rest in the desktop. */
export async function clearBrowsingData(choices: ClearChoices): Promise<void> {
  const { history, ...desktop } = choices;
  if (Object.values(desktop).some(Boolean)) {
    if (!previewBridge?.clearBrowsingData) throw new Error("Update Pathway to clear site data.");
    await previewBridge.clearBrowsingData(desktop);
  }
  if (history) useBrowserHistoryStore.getState().clearAll();
}

export function ClearBrowsingDataDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [showOptions, setShowOptions] = useState(false);
  const [choices, setChoices] = useState<ClearChoices>(ALL_CHOICES);
  const [busy, setBusy] = useState(false);
  const nothingChosen = !Object.values(choices).some(Boolean);

  const clear = async (selected: ClearChoices) => {
    setBusy(true);
    try {
      await clearBrowsingData(selected);
      toastManager.add({ type: "success", title: "Browsing data cleared" });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to clear browsing data",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) {
          setShowOptions(false);
          setChoices(ALL_CHOICES);
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Clear browsing data</DialogTitle>
          <DialogDescription>
            Clear browsing history, site data, cache, and download history from the in-app browser.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ms-2 text-muted-foreground"
            aria-expanded={showOptions}
            onClick={() => setShowOptions((value) => !value)}
          >
            {showOptions
              ? "Hide individual browsing data options"
              : "Show individual browsing data options"}
            <ChevronDownIcon className={showOptions ? "rotate-180" : undefined} />
          </Button>
          {showOptions ? (
            <div className="space-y-2">
              {CLEAR_OPTIONS.map((option) => (
                <label key={option.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={choices[option.key]}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setChoices((current) => ({ ...current, [option.key]: checked === true }))
                    }
                  />
                  {option.label}
                </label>
              ))}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {showOptions ? (
            <Button
              variant="destructive"
              disabled={busy || nothingChosen}
              onClick={() => void clear(choices)}
            >
              Clear browsing data
            </Button>
          ) : (
            <Button variant="destructive" disabled={busy} onClick={() => void clear(ALL_CHOICES)}>
              Clear all browsing data
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
