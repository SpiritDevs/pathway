import type { DesktopBrowserExtension } from "@spiritdevs/contracts";
import { PuzzleIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { useClientSettings } from "~/hooks/useSettings";

import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import { saveBrowserSetting } from "./saveBrowserSetting";

export function BrowserExtensionsSettings() {
  const extensionsApi = previewBridge?.extensions ?? null;
  const configured = useClientSettings((settings) => settings.browserExtensions);
  const [loaded, setLoaded] = useState<ReadonlyArray<DesktopBrowserExtension>>([]);

  useEffect(() => {
    if (!extensionsApi) return;
    let cancelled = false;
    const refresh = () =>
      void extensionsApi
        .list()
        .then((next) => {
          if (!cancelled) setLoaded(next);
        })
        .catch(() => undefined);
    refresh();
    const unsubscribe = extensionsApi.onChange(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [extensionsApi]);

  const install = async () => {
    if (!extensionsApi) return;
    const path = await window.desktopBridge?.pickFolder();
    if (!path) return;
    if (configured.some((extension) => extension.path === path)) {
      toastManager.add({ type: "info", title: "This extension is already installed" });
      return;
    }
    try {
      const manifest = await extensionsApi.inspect(path);
      saveBrowserSetting({ browserExtensions: [...configured, { path, enabled: true }] });
      toastManager.add({ type: "success", title: `Installed ${manifest.name}` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to install extension",
        description:
          error instanceof Error ? error.message : "Choose an unpacked extension folder.",
      });
    }
  };

  const setEnabled = (path: string, enabled: boolean) =>
    saveBrowserSetting({
      browserExtensions: configured.map((extension) =>
        extension.path === path ? { ...extension, enabled } : extension,
      ),
    });

  const remove = (path: string) =>
    saveBrowserSetting({
      browserExtensions: configured.filter((extension) => extension.path !== path),
    });

  // The desktop's list carries names and load errors; settings stay the source of truth.
  const rows = configured.map((extension) => {
    const info = loaded.find((candidate) => candidate.path === extension.path);
    return { ...extension, info };
  });

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Extension manager"
        headerAction={
          extensionsApi ? (
            <Button size="xs" variant="outline" onClick={() => void install()}>
              Load unpacked
            </Button>
          ) : null
        }
      >
        <div className="space-y-2 px-3 @xl/settings:px-4">
          <p className="text-[13px] text-muted-foreground/80">
            Install, remove, and configure browser extensions. Choose an unpacked Chrome extension
            folder, or import extensions from your browser.
          </p>
          {!extensionsApi ? (
            <p className="text-sm text-muted-foreground">Update Pathway to manage extensions.</p>
          ) : rows.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Installed extensions will appear here
            </p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-xl border">
              {rows.map((row) => (
                <li key={row.path} className="flex items-center gap-3 px-3 py-2">
                  <PuzzleIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {row.info?.name ?? row.path.split(/[\\/]/).at(-1)}
                      {row.info?.version ? (
                        <span className="ms-2 text-xs text-muted-foreground">
                          {row.info.version}
                        </span>
                      ) : null}
                    </p>
                    {row.info?.error ? (
                      <p className="truncate text-xs text-destructive">{row.info.error}</p>
                    ) : (
                      <p className="truncate text-xs text-muted-foreground" title={row.path}>
                        {row.info?.description || row.path}
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={row.enabled}
                    aria-label={`Enable ${row.info?.name ?? "extension"}`}
                    onCheckedChange={(checked) => setEnabled(row.path, checked)}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${row.info?.name ?? "extension"}`}
                    onClick={() => remove(row.path)}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
