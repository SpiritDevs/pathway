import { useAuth } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { isInAlertQuietHours } from "@spiritdevs/client-runtime/thread-alerts";
import type { EnvironmentId, StoragePressure } from "@spiritdevs/contracts";
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
            onClick: () => void navigate({ to: "/settings/archived" }),
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
            () => void navigate({ to: "/settings/archived" }),
            () => active,
          ).catch(() => {});
        }
      });
    }
    return () => {
      active = false;
    };
  }, [isSignedIn, userId, settingsReady, settings, pressures, navigate]);

  if (pressures.length === 0) return null;
  const critical = low.some((entry) => entry.displayedPressure === "critical");
  const color = critical
    ? "text-destructive"
    : low.length
      ? "text-warning"
      : "text-muted-foreground";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={`[-webkit-app-region:no-drag] ${color}`}
            aria-label="Environment storage"
          >
            <HardDriveIcon className={`size-4 ${color}`} />
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-80">
        <div className="w-full min-w-0">
          <h3 className="px-3 pt-3 pb-2 text-sm font-medium">Environment storage</h3>
          <div className="max-h-80 overflow-y-auto px-3">
            {pressures.map(({ environment, pressure, last }) => (
              <StorageEnvironmentRow
                key={environment.environmentId}
                environmentId={environment.environmentId}
                label={environment.label}
                pressure={pressure}
                lastPressure={last?.pressure}
                enabled={
                  open &&
                  environment.connection.phase === "connected" &&
                  environment.serverConfig?.environment.capabilities.storageManagement === true
                }
              />
            ))}
          </div>
          <div className="border-t p-2">
            <Button
              className="w-full"
              size="sm"
              variant="outline"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/settings/archived" });
              }}
            >
              Storage &amp; cleanup settings
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function StorageEnvironmentRow({
  environmentId,
  label,
  pressure,
  lastPressure,
  enabled,
}: {
  environmentId: EnvironmentId;
  label: string;
  pressure: StoragePressure;
  lastPressure: StoragePressure | undefined;
  enabled: boolean;
}) {
  const snapshot = useEnvironmentQuery(
    enabled ? serverEnvironment.storageSnapshot({ environmentId, input: {} }) : null,
  );
  const displayedPressure = pressure === "unknown" ? lastPressure : pressure;
  const color =
    displayedPressure === "critical"
      ? "text-destructive"
      : displayedPressure === "warning"
        ? "text-warning"
        : "text-muted-foreground";
  const status =
    displayedPressure === "critical"
      ? "Critical storage"
      : displayedPressure === "warning"
        ? "Low storage"
        : displayedPressure === "healthy"
          ? "Healthy"
          : "Unavailable";
  return (
    <div className="space-y-1 border-t py-2 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <HardDriveIcon className={`size-4 shrink-0 ${color}`} />
        <span className="min-w-0 flex-1 truncate text-sm" title={label}>
          {label}
        </span>
        <span className={`shrink-0 text-xs ${color}`}>{status}</span>
      </div>
      {pressure === "unknown" ? (
        <p className="text-xs text-muted-foreground">
          {lastPressure
            ? "Last known reading · current storage unavailable"
            : "Current storage unavailable"}
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
    </div>
  );
}
