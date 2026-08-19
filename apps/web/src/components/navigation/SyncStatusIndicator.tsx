import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { activeCompanyAtom, activeCompanyIdAtom } from "../../cloud/activeCompany";
import { cloudSyncAvailabilityAtom, companySyncStatusesAtom } from "../../cloud/syncStatus";
import {
  selectedCompanySyncStatusSummary,
  syncStatusPhaseLabel,
  type CompanySyncStatusSummary,
} from "../../cloud/syncStatus.logic";
import { ConnectionStatusDot } from "../ConnectionStatusDot";

// #region DEBUG
function debugSyncStatusIndicator(
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  void fetch("/api/__debug/cloud-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hypothesis: "H4", event, fields }),
  }).catch(() => undefined);
}
// #endregion DEBUG

function dotClasses(status: CompanySyncStatusSummary | null) {
  if (status === null) return { dotClassName: "bg-muted-foreground/40", pingClassName: null };
  if (status.phase === "error") {
    return { dotClassName: "bg-destructive", pingClassName: null };
  }
  if (status.phase === "bootstrapping" || status.phase === "reconnecting") {
    return { dotClassName: "bg-warning", pingClassName: "bg-warning/60 duration-2000" };
  }
  return { dotClassName: "bg-success", pingClassName: null };
}

export function SyncStatusIndicator() {
  const availability = useAtomValue(cloudSyncAvailabilityAtom);
  const activeCompanyId = useAtomValue(activeCompanyIdAtom);
  const activeCompany = useAtomValue(activeCompanyAtom);
  const statuses = useAtomValue(companySyncStatusesAtom);
  const status = selectedCompanySyncStatusSummary(activeCompanyId, statuses);

  useEffect(() => {
    // #region DEBUG
    debugSyncStatusIndicator("indicator-state-observed", {
      availabilityPhase: availability.phase,
      tabRole: availability.phase === null ? availability.tab.role : null,
      activeCompanySelected: activeCompanyId !== null,
      activeCompanyResolved: activeCompany !== null,
      statusCount: statuses.size,
      selectedStatusPhase: status?.phase ?? null,
      selectedStatusCompanyCount: status?.companyCount ?? 0,
    });
    // #endregion DEBUG
  }, [activeCompany, activeCompanyId, availability, status, statuses]);

  if (availability.phase !== null) return null;

  if (availability.tab.role === "follower") {
    return (
      <ConnectionStatusDot
        dotClassName="bg-muted-foreground/40"
        tooltipText="Cloud sync is running in another tab. Open that tab for live company status."
      />
    );
  }

  if (availability.tab.role === "inactive") {
    return (
      <ConnectionStatusDot
        dotClassName="bg-warning"
        pingClassName="bg-warning/60 duration-2000"
        tooltipText="Cloud sync is starting…"
      />
    );
  }

  const companyName =
    activeCompany?.name ??
    (activeCompanyId === null ? "All companies" : `Company ${activeCompanyId}`);
  const tooltip =
    status === null
      ? `${companyName}\nWaiting for engine status…`
      : [
          companyName,
          syncStatusPhaseLabel(status.phase),
          `${status.pendingCount} pending ${status.pendingCount === 1 ? "operation" : "operations"}`,
          status.lastError === null
            ? null
            : `${status.lastError.classification}: ${status.lastError.message}`,
          availability.tab.crossContext
            ? null
            : "This browser cannot coordinate sync ownership across tabs.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n");

  return <ConnectionStatusDot tooltipText={tooltip} {...dotClasses(status)} />;
}
