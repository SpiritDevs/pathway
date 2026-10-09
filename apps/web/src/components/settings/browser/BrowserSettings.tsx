import type { BrowserHistoryAccess, BrowserLinkTarget } from "@spiritdevs/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { openBrowserDialog } from "~/browser/browserDialogs";
import { previewBridge } from "~/components/preview/previewBridge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useClientSettings } from "~/hooks/useSettings";

import { searchableSetting, type SettingsSearchItemId } from "../settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { BrowserAgentPermissionsSection } from "./BrowserAgentPermissionsSection";
import { saveBrowserSetting } from "./saveBrowserSetting";

const LINK_TARGET_LABELS: Readonly<Record<BrowserLinkTarget, string>> = {
  browser: "Pathway",
  external: "Default browser",
};

const HISTORY_ACCESS_OPTIONS: ReadonlyArray<{
  readonly value: BrowserHistoryAccess;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "ask", label: "Always ask", description: "Ask before accessing history" },
  { value: "allow", label: "Always allow", description: "Access history without asking" },
  { value: "disabled", label: "Disable", description: "Do not allow access to history" },
];

function OptionSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger className="w-full sm:w-44" aria-label={label}>
        <SelectValue>{options.find((option) => option.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ManageRow({
  setting,
  description,
  to,
}: {
  readonly setting: SettingsSearchItemId;
  readonly description: string;
  readonly to:
    | "/settings/browser/history"
    | "/settings/browser/downloads"
    | "/settings/browser/passwords"
    | "/settings/browser/contact-info"
    | "/settings/browser/site-settings"
    | "/settings/browser/extensions";
}) {
  return (
    <SettingsRow
      {...searchableSetting(setting)}
      description={description}
      control={
        <Button render={<Link to={to} />} size="xs" variant="outline">
          Manage
        </Button>
      }
    />
  );
}

const linkTargetOptions = (Object.keys(LINK_TARGET_LABELS) as BrowserLinkTarget[])
  .toReversed()
  .map((value) => ({ value, label: LINK_TARGET_LABELS[value] }));

export function BrowserSettings() {
  const settings = useClientSettings();
  const [systemDownloads, setSystemDownloads] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void previewBridge?.downloads
      ?.defaultDirectory()
      .then((directory) => {
        if (!cancelled) setSystemDownloads(directory);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseDownloadDirectory = async () => {
    const directory = await window.desktopBridge?.pickFolder({
      initialPath: settings.browserDownloadDirectory || systemDownloads,
    });
    if (directory) saveBrowserSetting({ browserDownloadDirectory: directory });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Browser">
        <SettingsRow
          {...searchableSetting("browser-agent-control")}
          description="Manage your Browser Use preferences and site access."
          control={
            <Switch
              checked={settings.browserAgentControlEnabled}
              aria-label="Let agents control the built-in browser"
              onCheckedChange={(checked) =>
                saveBrowserSetting({ browserAgentControlEnabled: checked })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="General">
        <SettingsRow
          {...searchableSetting("browser-import")}
          description="Bring saved passwords, cookies, history, and extensions from Chrome and other browsers."
          control={
            <Button size="xs" variant="outline" onClick={() => openBrowserDialog("import")}>
              Import
            </Button>
          }
        />
        <SettingsRow
          {...searchableSetting("browser-web-links")}
          description="Where web links open by default"
          control={
            <OptionSelect
              label="Web link target"
              value={settings.browserWebLinkTarget}
              options={linkTargetOptions}
              onChange={(value) => saveBrowserSetting({ browserWebLinkTarget: value })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("browser-local-links")}
          description="Where local development sites open by default"
          control={
            <OptionSelect
              label="Local URL open destination"
              value={settings.browserLocalLinkTarget}
              options={linkTargetOptions}
              onChange={(value) => saveBrowserSetting({ browserLocalLinkTarget: value })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("browser-full-url")}
          description="Include the path, query, and fragment in the address bar"
          control={
            <Switch
              checked={settings.browserShowFullUrl}
              aria-label="Show full URL"
              onCheckedChange={(checked) => saveBrowserSetting({ browserShowFullUrl: checked })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("browser-clear-data")}
          description="Clear browsing history, site data, cache, and download history from the in-app browser"
          control={
            <Button size="xs" variant="outline" onClick={() => openBrowserDialog("clear-data")}>
              Clear
            </Button>
          }
        />
        <ManageRow
          setting="browser-history"
          description="View and manage pages visited in the built-in browser"
          to="/settings/browser/history"
        />
        <SettingsRow
          {...searchableSetting("browser-annotation-screenshots")}
          description="Screenshots help agents better understand and address comments, but increase plan usage"
          control={
            <OptionSelect
              label="Annotation screenshots"
              value={settings.browserAnnotationScreenshots}
              options={[
                { value: "always", label: "Always include" },
                { value: "drag", label: "Only on drag selection" },
              ]}
              onChange={(value) => saveBrowserSetting({ browserAnnotationScreenshots: value })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Autofill and passwords">
        <ManageRow
          setting="browser-passwords"
          description="Add, delete, and edit saved passwords"
          to="/settings/browser/passwords"
        />
        <ManageRow
          setting="browser-contact-info"
          description="Add, delete, and edit saved addresses, phone numbers, and email addresses"
          to="/settings/browser/contact-info"
        />
      </SettingsSection>

      <SettingsSection title="Extensions">
        <ManageRow
          setting="browser-extensions"
          description="Install, remove, and configure browser extensions"
          to="/settings/browser/extensions"
        />
      </SettingsSection>

      <SettingsSection title="Downloads">
        <SettingsRow
          {...searchableSetting("browser-download-location")}
          description={
            <span className="break-all">
              {settings.browserDownloadDirectory || systemDownloads || "System Downloads folder"}
            </span>
          }
          control={
            <>
              {settings.browserDownloadDirectory ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => saveBrowserSetting({ browserDownloadDirectory: "" })}
                >
                  Reset
                </Button>
              ) : null}
              <Button size="xs" variant="outline" onClick={() => void chooseDownloadDirectory()}>
                Change
              </Button>
            </>
          }
        />
        <SettingsRow
          {...searchableSetting("browser-ask-where-to-save")}
          description="Show a save dialog for downloads you start in the built-in browser"
          control={
            <Switch
              checked={settings.browserAskWhereToSave}
              aria-label="Ask where to save downloads"
              onCheckedChange={(checked) => saveBrowserSetting({ browserAskWhereToSave: checked })}
            />
          }
        />
        <ManageRow
          setting="browser-download-history"
          description="View and manage files downloaded from the built-in browser"
          to="/settings/browser/downloads"
        />
      </SettingsSection>

      <SettingsSection title="Permissions">
        <ManageRow
          setting="browser-site-settings"
          description="Choose what websites can use in the built-in browser, such as your camera, microphone, and location"
          to="/settings/browser/site-settings"
        />
        <SettingsRow
          {...searchableSetting("browser-history-access")}
          description={`Choose if agents ask for approval before accessing your browser's history. ${
            HISTORY_ACCESS_OPTIONS.find((option) => option.value === settings.browserHistoryAccess)
              ?.description ?? ""
          }.`}
          control={
            <OptionSelect
              label="History approval"
              value={settings.browserHistoryAccess}
              options={HISTORY_ACCESS_OPTIONS}
              onChange={(value) => saveBrowserSetting({ browserHistoryAccess: value })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("browser-site-tools")}
          description="Allow agents to discover and call site tools exposed by websites, including WebMCP"
          control={
            <Switch
              checked={settings.browserSiteToolsEnabled}
              aria-label="Enable site tools"
              onCheckedChange={(checked) =>
                saveBrowserSetting({ browserSiteToolsEnabled: checked })
              }
            />
          }
        />
      </SettingsSection>

      <BrowserAgentPermissionsSection />

      <SettingsSection title="Developer mode">
        <SettingsRow
          {...searchableSetting("browser-full-cdp")}
          title={
            <span className="flex items-center gap-2">
              {searchableSetting("browser-full-cdp").title}
              <Badge variant="warning" size="sm">
                Elevated risk
              </Badge>
            </span>
          }
          description="Allow agents to use full Chrome DevTools Protocol (CDP) access. This lets agents inspect and control sensitive browser internals that may put your data at risk."
          control={
            <Switch
              checked={settings.browserFullCdpEnabled}
              aria-label="Enable full CDP access"
              onCheckedChange={(checked) => saveBrowserSetting({ browserFullCdpEnabled: checked })}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
