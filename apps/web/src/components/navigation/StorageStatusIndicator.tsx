import { useAuth } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { isInAlertQuietHours } from "@spiritdevs/client-runtime/thread-alerts";
import type { StoragePressure } from "@spiritdevs/contracts";
import { HardDriveIcon } from "lucide-react";
import { useEffect } from "react";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useStoragePressure } from "../../hooks/useStoragePressure";
import { storagePressureTransition } from "../../lib/storagePresentation";
import { showThreadAlert } from "../../threadAlerts/delivery";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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

  if (low.length === 0) return null;
  const critical = low.some((entry) => entry.displayedPressure === "critical");
  const label = `${low.length} ${low.length === 1 ? "environment" : "environments"} ${critical ? "critically low" : "low"} on storage${low.some((entry) => entry.stale) ? ". Includes a last-known reading." : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={`[-webkit-app-region:no-drag] ${critical ? "text-destructive" : "text-warning"}`}
            aria-label={label}
            onClick={() => void navigate({ to: "/settings/archived" })}
          >
            <HardDriveIcon className="size-4" />
            <span className="text-xs">Storage{low.length > 1 ? ` · ${low.length}` : ""}</span>
          </Button>
        }
      />
      <TooltipPopup>
        {low
          .map(
            (entry) =>
              `${entry.environment.label}: ${entry.displayedPressure}${entry.stale ? ` at ${new Date(entry.last!.sampledAt).toLocaleString()} · current capacity unavailable` : ""}`,
          )
          .join(" · ")}
      </TooltipPopup>
    </Tooltip>
  );
}
