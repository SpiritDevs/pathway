import {
  BROWSER_SITE_PERMISSIONS,
  BROWSER_SITE_PERMISSIONS_WITHOUT_PROMPT,
  type BrowserSitePermission,
  type BrowserSitePermissionValue,
  resolveBrowserSitePermission,
  setBrowserSitePermission,
} from "@spiritdevs/contracts";
import { Trash2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useClientSettings } from "~/hooks/useSettings";

import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { saveBrowserSetting } from "./saveBrowserSetting";

export const BROWSER_SITE_PERMISSION_LABELS: Readonly<Record<BrowserSitePermission, string>> = {
  camera: "Camera",
  microphone: "Microphone",
  location: "Location",
  notifications: "Notifications",
  clipboard: "Clipboard",
  midi: "MIDI devices",
  popups: "Pop-ups and redirects",
  sound: "Sound",
};

const VALUE_LABELS: Readonly<Record<BrowserSitePermissionValue, string>> = {
  ask: "Ask",
  allow: "Allow",
  block: "Block",
};

const valuesFor = (permission: BrowserSitePermission): ReadonlyArray<BrowserSitePermissionValue> =>
  BROWSER_SITE_PERMISSIONS_WITHOUT_PROMPT.has(permission)
    ? ["allow", "block"]
    : ["ask", "allow", "block"];

function PermissionSelect({
  permission,
  value,
  ariaLabel,
  onChange,
}: {
  readonly permission: BrowserSitePermission;
  readonly value: BrowserSitePermissionValue;
  readonly ariaLabel: string;
  readonly onChange: (value: BrowserSitePermissionValue) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as BrowserSitePermissionValue)}>
      <SelectTrigger size="sm" className="w-full sm:w-32" aria-label={ariaLabel}>
        <SelectValue>{VALUE_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {valuesFor(permission).map((option) => (
          <SelectItem hideIndicator key={option} value={option}>
            {VALUE_LABELS[option]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function BrowserSiteSettings() {
  const settings = useClientSettings((current) => current.browserSitePermissions);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Default permissions">
        {BROWSER_SITE_PERMISSIONS.map((permission) => (
          <SettingsRow
            key={permission}
            title={BROWSER_SITE_PERMISSION_LABELS[permission]}
            control={
              <PermissionSelect
                permission={permission}
                value={resolveBrowserSitePermission(settings, null, permission)}
                ariaLabel={`Default ${BROWSER_SITE_PERMISSION_LABELS[permission]} permission`}
                onChange={(value) =>
                  saveBrowserSetting({
                    browserSitePermissions: {
                      ...settings,
                      defaults: { ...settings.defaults, [permission]: value },
                    },
                  })
                }
              />
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Sites">
        <div className="space-y-2 px-3 @xl/settings:px-4">
          {settings.sites.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Choices you make when a site asks for a permission will appear here
            </p>
          ) : (
            settings.sites.map((site) => (
              <div key={site.origin} className="space-y-1 rounded-xl border px-3 py-2">
                <p className="truncate text-sm font-medium">{site.origin}</p>
                {(Object.keys(site.permissions) as BrowserSitePermission[]).map((permission) => (
                  <div key={permission} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                      {BROWSER_SITE_PERMISSION_LABELS[permission]}
                    </span>
                    <PermissionSelect
                      permission={permission}
                      value={resolveBrowserSitePermission(settings, site.origin, permission)}
                      ariaLabel={`${BROWSER_SITE_PERMISSION_LABELS[permission]} permission for ${site.origin}`}
                      onChange={(value) =>
                        saveBrowserSetting({
                          browserSitePermissions: setBrowserSitePermission(
                            settings,
                            site.origin,
                            permission,
                            value,
                          ),
                        })
                      }
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Reset ${BROWSER_SITE_PERMISSION_LABELS[permission]} for ${site.origin}`}
                      onClick={() =>
                        saveBrowserSetting({
                          browserSitePermissions: setBrowserSitePermission(
                            settings,
                            site.origin,
                            permission,
                            null,
                          ),
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
