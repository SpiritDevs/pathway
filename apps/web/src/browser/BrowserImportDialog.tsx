import type {
  DesktopBrowserImportProfile,
  DesktopBrowserImportResult,
} from "@spiritdevs/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { browserPasswordFunctions, useBrowserPasswordClient } from "~/cloud/browserPasswords";
import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { useBrowserHistoryStore } from "~/browserHistoryStore";
import { getClientSettings, persistClientSettingsPatch } from "~/hooks/useSettings";
import { useEnvironments } from "~/state/environments";

import { isThisMachineTarget } from "./browserPlacement";

type ImportKind = "passwords" | "cookies" | "history" | "extensions";

const IMPORT_OPTIONS: ReadonlyArray<{ readonly key: ImportKind; readonly label: string }> = [
  { key: "passwords", label: "Saved passwords" },
  { key: "cookies", label: "Cookies" },
  { key: "history", label: "Browsing history" },
  { key: "extensions", label: "Extensions" },
];

const DEFAULT_KINDS: Readonly<Record<ImportKind, boolean>> = {
  passwords: true,
  cookies: true,
  history: true,
  extensions: false,
};

const profileKey = (profile: DesktopBrowserImportProfile) =>
  `${profile.browserId}/${profile.profileDirectory}`;

const profileLabel = (profile: DesktopBrowserImportProfile) =>
  `${profile.browserName} · ${profile.profileName}`;

export function BrowserImportDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const importer = previewBridge?.browserImport ?? null;
  const passwordClient = useBrowserPasswordClient();
  const { environments } = useEnvironments();
  const [profiles, setProfiles] = useState<ReadonlyArray<DesktopBrowserImportProfile> | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [kinds, setKinds] = useState(DEFAULT_KINDS);
  const [browserRunning, setBrowserRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const selected = profiles?.find((profile) => profileKey(profile) === selectedKey) ?? null;

  useEffect(() => {
    if (!open || !importer) return;
    let cancelled = false;
    void importer
      .listProfiles()
      .then((next) => {
        if (cancelled) return;
        setProfiles(next);
        setSelectedKey((current) => current ?? (next[0] ? profileKey(next[0]) : null));
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, importer]);

  useEffect(() => {
    if (!open || !importer || !selected) return;
    let cancelled = false;
    const check = () =>
      void importer
        .isBrowserRunning(selected.browserId)
        .then((running) => {
          if (!cancelled) setBrowserRunning(running);
        })
        .catch(() => undefined);
    check();
    // Cookies and history are locked while the browser runs; recheck when the user returns.
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [open, importer, selected]);

  const run = async () => {
    if (!importer || !selected) return;
    setBusy(true);
    try {
      const result = await importer.run({
        profile: selected,
        ...kinds,
        environmentIds: environments
          .filter((environment) => isThisMachineTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      });
      const savedPasswords = await savePasswords(result);
      saveHistory(result);
      await saveExtensions(result);
      const failedPasswords = result.passwords.length - savedPasswords;
      const skipped = [
        ...result.skipped.map((entry) => entry.reason),
        ...(failedPasswords > 0 ? [`${failedPasswords} passwords could not be saved.`] : []),
      ];
      toastManager.add({
        type: skipped.length > 0 ? "warning" : "success",
        title: `Imported from ${selected.browserName}`,
        description: [importSummary(result, savedPasswords), ...skipped].join(" "),
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to import browser data",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const savePasswords = async (result: DesktopBrowserImportResult): Promise<number> => {
    if (!passwordClient) return 0;
    const saves = await Promise.allSettled(
      result.passwords.map((login) =>
        passwordClient.action(browserPasswordFunctions.save, {
          label: URL.canParse(login.origin) ? new URL(login.origin).hostname : login.origin,
          origin: login.origin,
          username: login.username,
          password: login.password,
        }),
      ),
    );
    return saves.filter((save) => save.status === "fulfilled").length;
  };

  const saveHistory = (result: DesktopBrowserImportResult) => {
    if (result.history.length === 0) return;
    useBrowserHistoryStore.getState().importEntries(
      result.history.flatMap((page) => {
        const visitedAt = Date.parse(page.lastVisitedAt);
        if (!Number.isFinite(visitedAt)) return [];
        return [
          {
            url: page.url,
            lastVisitedAt: visitedAt,
            visits: Math.max(1, page.visits),
            ...(page.title ? { title: page.title } : {}),
          },
        ];
      }),
    );
  };

  const saveExtensions = async (result: DesktopBrowserImportResult) => {
    if (result.extensions.length === 0) return;
    const current = getClientSettings().browserExtensions;
    const known = new Set(current.map((extension) => extension.path));
    const added = result.extensions
      .filter((extension) => !known.has(extension.path))
      .map((extension) => ({ path: extension.path, enabled: true }));
    if (added.length > 0) {
      await persistClientSettingsPatch({ browserExtensions: [...current, ...added] });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import from your browser</DialogTitle>
          <DialogDescription>
            Bring saved passwords, cookies, browsing history, and extensions into the built-in
            browser.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {!importer ? (
            <p className="text-sm text-muted-foreground">Update Pathway to import browser data.</p>
          ) : profiles === null ? (
            <p className="text-sm text-muted-foreground">Looking for browsers…</p>
          ) : profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No supported browsers were found on this computer.
            </p>
          ) : (
            <>
              <Select
                value={selectedKey ?? ""}
                onValueChange={(value) => setSelectedKey(value as string)}
              >
                <SelectTrigger className="w-full" aria-label="Browser profile" disabled={busy}>
                  <SelectValue>
                    {selected ? profileLabel(selected) : "Choose a browser"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {profiles.map((profile) => (
                    <SelectItem key={profileKey(profile)} value={profileKey(profile)}>
                      {profileLabel(profile)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {selected && browserRunning && (kinds.cookies || kinds.history) ? (
                <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                  Close {selected.browserName} completely before importing
                </p>
              ) : null}
              <div className="space-y-1">
                {IMPORT_OPTIONS.map((option) => (
                  <label
                    key={option.key}
                    className="flex items-center justify-between gap-4 py-1.5 text-sm"
                  >
                    {option.label}
                    <Switch
                      checked={kinds[option.key]}
                      disabled={busy || (option.key === "passwords" && !passwordClient)}
                      onCheckedChange={(checked) =>
                        setKinds((current) => ({ ...current, [option.key]: checked }))
                      }
                    />
                  </label>
                ))}
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || !selected || !Object.values(kinds).some(Boolean)}
            onClick={() => void run()}
          >
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function importSummary(result: DesktopBrowserImportResult, savedPasswords: number): string {
  const parts = [
    savedPasswords > 0 ? `${savedPasswords} passwords` : null,
    result.cookies > 0 ? `${result.cookies} cookies` : null,
    result.history.length > 0 ? `${result.history.length} pages of history` : null,
    result.extensions.length > 0 ? `${result.extensions.length} extensions` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Nothing new to import." : `Imported ${parts.join(", ")}.`;
}
