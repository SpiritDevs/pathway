import { useAuth } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { isInAlertQuietHours } from "@spiritdevs/client-runtime/thread-alerts";
import type { StoragePressure } from "@spiritdevs/contracts";
import { HardDriveIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useStoragePressure } from "../../hooks/useStoragePressure";
import { formatStorageBytes, storagePressureTransition } from "../../lib/storagePresentation";
import { showThreadAlert } from "../../threadAlerts/delivery";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentDeviceIcon } from "../EnvironmentDeviceIcon";

const lastPressures = new Map<string, StoragePressure>();

async function claimTransition(key: string, pressure: StoragePressure) {
  const claim = () => {
    let previous = lastPressures.get(key);
    try {
      const persisted = localStorage.getItem(key);
      if (persisted === "critical" || persisted === "warning" || persisted === "healthy")
        previous = persisted;
    } catch {
      /* Keep the in-memory state when client storage is unavailable. */
    }
    const transition = storagePressureTransition(previous, pressure);
    if (pressure !== "unknown") {
      lastPressures.set(key, pressure);
      try {
        localStorage.setItem(key, pressure);
      } catch {
        /* In-memory deduplication still applies. */
      }
    }
    return transition;
  };
  return navigator.locks ? navigator.locks.request(key, claim).catch(() => claim()) : claim();
}

export function StorageStatusIndicator() {
  const { userId, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const settings = useClientSettings((value) => value.threadAlerts);
  const settingsReady = useClientSettingsHydrated();
  const pressures = useStoragePressure(isSignedIn ? userId : null);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const low = pressures.flatMap((entry) => {
    const displayedPressure = entry.pressure === "unknown" ? entry.last?.pressure : entry.pressure;
    return displayedPressure === "critical" || displayedPressure === "warning"
      ? [{ ...entry, displayedPressure, stale: entry.pressure === "unknown" }]
      : [];
  });

  useEffect(() => {
    if (!isSignedIn || !userId || !settingsReady) return;
    let active = true;
    for (const entry of pressures) {
      if (entry.pressure === "unknown") continue;
      const { environment, pressure } = entry;
      const key = `pathway:storage-pressure:${userId}:${environment.environmentId}`;
      const openCleanup = () =>
        navigate({ to: "/settings/archived", search: { environment: environment.environmentId } });
      void claimTransition(key, pressure).then(async (transition) => {
        if (!active || !transition) return;
        const title =
          transition === "recovered"
            ? `${environment.label} has recovered storage space`
            : `${environment.label} is ${pressure === "critical" ? "critically low" : "low"} on storage`;
        const description =
          transition === "recovered"
            ? "Available space is above the warning thresholds."
            : "Review Storage & cleanup to free space. Emergency cleanup only runs when you request it.";
        toastManager.add({
          id: `storage:${environment.environmentId}`,
          type: transition === "recovered" ? "success" : "warning",
          title,
          description,
          actionProps: {
            children: "Review storage",
            onClick: () => void openCleanup(),
          },
        });
        if (
          settings.osNotificationsEnabled &&
          !isInAlertQuietHours(settings.quietHours, new Date())
        ) {
          await showThreadAlert(
            {
              userId,
              id: `storage:${environment.environmentId}`,
              title,
              body: description,
              target: { kind: "storage", environmentId: environment.environmentId },
            },
            () => void openCleanup(),
            () => active,
          ).catch(() => {});
        }
      });
    }
    return () => {
      active = false;
    };
  }, [isSignedIn, userId, settingsReady, settings, pressures, navigate]);

  if (low.length === 0) return null;
  const critical = low.some((entry) => entry.displayedPressure === "critical");
  const color = critical ? "text-destructive" : "text-warning";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={`rounded-full [-webkit-app-region:no-drag] ${color}`}
            aria-label="Environment storage"
          >
            <HardDriveIcon className={`size-4 ${color}`} />
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-80" side="right" sideOffset={10}>
        <div className="w-full min-w-0">
          <h3 className="px-3 pt-3 pb-1 text-sm font-medium">Environment storage</h3>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {low.map(({ environment, displayedPressure, stale }) => (
              <StorageEnvironmentRow
                key={environment.environmentId}
                environment={environment}
                critical={displayedPressure === "critical"}
                stale={stale}
                enabled={
                  open &&
                  environment.connection.phase === "connected" &&
                  environment.serverConfig?.environment.capabilities.storageManagement === true
                }
                onSelect={() => {
                  setOpen(false);
                  void navigate({
                    to: "/settings/archived",
                    search: { environment: environment.environmentId },
                  });
                }}
              />
            ))}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function StorageEnvironmentRow({
  environment,
  critical,
  stale,
  enabled,
  onSelect,
}: {
  environment: EnvironmentPresentation;
  critical: boolean;
  stale: boolean;
  enabled: boolean;
  onSelect: () => void;
}) {
  const { environmentId, label } = environment;
  const snapshot = useEnvironmentQuery(
    enabled ? serverEnvironment.storageSnapshot({ environmentId, input: {} }) : null,
  );
  const color = critical ? "text-destructive" : "text-warning";
  return (
    <button
      type="button"
      className="block w-full space-y-1 rounded-lg px-1.5 py-2 text-left outline-none hover:bg-foreground/6 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onSelect}
    >
      <div className="flex min-w-0 items-center gap-2">
        <EnvironmentDeviceIcon environment={environment} className={`size-4 shrink-0 ${color}`} />
        <span className="min-w-0 flex-1 truncate text-sm" title={label}>
          {label}
        </span>
        <span className={`shrink-0 text-xs ${color}`}>
          {critical ? "Critical storage" : "Low storage"}
        </span>
      </div>
      {stale ? (
        <p className="text-xs text-muted-foreground">
          Last known reading · current storage unavailable
        </p>
      ) : snapshot.data?.volumes.length ? (
        snapshot.data.volumes.map((volume) => (
          <p key={volume.id} className="truncate text-xs text-muted-foreground" title={volume.path}>
            {volume.path}: {formatStorageBytes(volume.availableBytes)} free of{" "}
            {formatStorageBytes(volume.totalBytes)}
          </p>
        ))
      ) : (
        <p className="text-xs text-muted-foreground">
          {snapshot.isPending ? "Loading capacity…" : "Capacity unavailable"}
        </p>
      )}
    </button>
  );
}
