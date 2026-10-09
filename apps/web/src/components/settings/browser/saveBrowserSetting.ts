import type { ClientSettingsPatch } from "@spiritdevs/contracts";

import { toastManager } from "~/components/ui/toast";
import { persistClientSettingsPatch } from "~/hooks/useSettings";

/** Saves a browser setting, telling the user when it could not be saved. */
export function saveBrowserSetting(patch: ClientSettingsPatch): void {
  persistClientSettingsPatch(patch).catch(() => {
    toastManager.add({ type: "error", title: "Unable to save browser setting" });
  });
}
