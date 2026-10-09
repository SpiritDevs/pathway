import {
  setBrowserSitePermission,
  type DesktopBrowserPermissionRequest,
} from "@spiritdevs/contracts";
import { useEffect, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { BROWSER_SITE_PERMISSION_LABELS } from "~/components/settings/browser/BrowserSiteSettings";
import { saveBrowserSetting } from "~/components/settings/browser/saveBrowserSetting";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { getClientSettings } from "~/hooks/useSettings";

/**
 * Asks about site permissions set to Ask in Settings → Browser → Site settings.
 * The desktop denies the request itself when it goes unanswered.
 */
export function BrowserPermissionPromptHost() {
  const permissionsApi = previewBridge?.permissions ?? null;
  const [requests, setRequests] = useState<ReadonlyArray<DesktopBrowserPermissionRequest>>([]);

  useEffect(() => {
    if (!permissionsApi) return;
    return permissionsApi.onEvent((event) =>
      setRequests((current) =>
        event.type === "request"
          ? [...current, event.request]
          : current.filter((request) => request.requestId !== event.requestId),
      ),
    );
  }, [permissionsApi]);

  const current = requests[0] ?? null;
  const answer = (allow: boolean, remember: boolean) => {
    if (!current || !permissionsApi) return;
    setRequests((pending) => pending.filter((request) => request.requestId !== current.requestId));
    if (remember) {
      let next = getClientSettings().browserSitePermissions;
      for (const permission of current.permissions) {
        next = setBrowserSitePermission(next, current.origin, permission, "allow");
      }
      saveBrowserSetting({ browserSitePermissions: next });
    }
    void permissionsApi.respond({ requestId: current.requestId, allow }).catch(() => undefined);
  };

  const host =
    current && URL.canParse(current.origin) ? new URL(current.origin).host : current?.origin;
  const wants = current
    ? current.permissions
        .map((permission) => BROWSER_SITE_PERMISSION_LABELS[permission].toLocaleLowerCase())
        .join(" and ")
    : "";

  return (
    <AlertDialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) answer(false, false);
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{`${host} wants to use your ${wants}`}</AlertDialogTitle>
          <AlertDialogDescription>
            You can change what this site may use in Settings → Browser → Site settings.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => answer(false, false)}>
            Block
          </Button>
          <Button variant="outline" onClick={() => answer(true, false)}>
            Allow this time
          </Button>
          <Button onClick={() => answer(true, true)}>Always allow</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
