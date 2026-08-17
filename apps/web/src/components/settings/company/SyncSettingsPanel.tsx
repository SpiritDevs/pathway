import { useAtomValue } from "@effect/atom-react";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { CloudIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { activeCompanyIdAtom, companyListAtom } from "../../../cloud/activeCompany";
import { cloudSyncAvailabilityAtom, companySyncStatusesAtom } from "../../../cloud/syncStatus";
import {
  syncStatusPhaseLabel,
  type CompanySyncStatus,
  type SyncStatusPhase,
} from "../../../cloud/syncStatus.logic";
import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
import { SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { CompanySectionCard, CompanySettingsEmptyState } from "./CompanySettingsShared";

function phaseBadgeVariant(phase: SyncStatusPhase) {
  if (phase === "live") return "success" as const;
  if (phase === "error") return "error" as const;
  if (phase === "bootstrapping" || phase === "reconnecting") return "warning" as const;
  return "secondary" as const;
}

function CompanyStatusCard({
  companyId,
  name,
  active,
  status,
}: {
  readonly companyId: CompanyId;
  readonly name: string;
  readonly active: boolean;
  readonly status: CompanySyncStatus | null;
}) {
  return (
    <div
      className={cn(
        "space-y-4 border-b px-4 py-4 last:border-b-0",
        active && "bg-primary/[0.035] ring-1 ring-inset ring-primary/15",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium">{name}</h3>
            {active ? <Badge variant="info">Active company</Badge> : null}
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{companyId}</p>
        </div>
        {status === null ? (
          <Badge variant="warning">Starting</Badge>
        ) : (
          <Badge variant={phaseBadgeVariant(status.phase)}>
            {syncStatusPhaseLabel(status.phase)}
          </Badge>
        )}
      </div>

      {status === null ? (
        <p className="text-xs text-muted-foreground">Waiting for this company’s engine status.</p>
      ) : (
        <>
          <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Bootstrap</dt>
              <dd className="mt-0.5 font-medium">
                {status.bootstrapComplete ? "Complete" : "In progress"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Pending outbox</dt>
              <dd className="mt-0.5 font-medium">{status.pendingCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Blocked</dt>
              <dd className="mt-0.5 font-medium">{status.blockedCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Recovery items</dt>
              <dd className="mt-0.5 font-medium">
                {status.rejectedCount + status.quarantinedCount}
              </dd>
            </div>
          </dl>

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">Pending operation kinds</p>
            <div className="flex flex-wrap gap-1.5">
              {status.pendingKinds.length === 0 ? (
                <span className="text-xs text-muted-foreground">None</span>
              ) : (
                status.pendingKinds.map(({ kind, count }) => (
                  <Badge key={kind} variant="outline" className="font-mono">
                    {kind} × {count}
                  </Badge>
                ))
              )}
            </div>
          </div>

          {status.lastError !== null ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5">
              <p className="text-xs font-medium text-destructive">
                {status.lastError.classification}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {status.lastError.message}
              </p>
            </div>
          ) : null}

          {status.rejectedCount > 0 || status.quarantinedCount > 0 ? (
            <p className="text-xs text-warning-foreground">
              {status.rejectedCount} rejected and {status.quarantinedCount} unreadable local
              {status.rejectedCount + status.quarantinedCount === 1
                ? " operation needs"
                : " operations need"}{" "}
              recovery.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function CloudSyncDiagnostics() {
  const availability = useAtomValue(cloudSyncAvailabilityAtom);
  const companies = useAtomValue(companyListAtom);
  const statuses = useAtomValue(companySyncStatusesAtom);
  const activeCompanyId = useAtomValue(activeCompanyIdAtom);
  const rows = useMemo(() => {
    const names = new Map(companies.map((company) => [company.id, company.name] as const));
    const ids = new Set<CompanyId>([...names.keys(), ...statuses.keys()]);
    return [...ids]
      .map((companyId) => ({
        companyId,
        name: names.get(companyId) ?? `Company ${companyId}`,
        status: statuses.get(companyId) ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [companies, statuses]);

  let content: ReactNode;
  let lacksCrossTabLeadership = false;
  if (availability.phase === "disabled") {
    content = (
      <CompanySettingsEmptyState
        title="Cloud sync is not configured"
        description="This Pathway deployment has cloud sync disabled. No browser sync engine is running."
      />
    );
  } else if (availability.phase === "signed-out") {
    content = (
      <CompanySettingsEmptyState
        title="Sign in to view sync status"
        description="Company sync health is available after you sign in."
      />
    );
  } else if (!("tab" in availability)) {
    content = null;
  } else {
    lacksCrossTabLeadership = !availability.tab.crossContext;
    content =
      availability.tab.role === "follower" ? (
        <CompanySettingsEmptyState
          title="Sync is running in another tab"
          description="Only the leader tab opens company sync engines. Open that tab to see live per-company status, or close it to let this tab take over."
        />
      ) : availability.tab.role === "inactive" ? (
        <CompanySettingsEmptyState
          title="Cloud sync is starting"
          description="Pathway is preparing the tab leader election and company sync engines."
        />
      ) : rows.length === 0 ? (
        <CompanySettingsEmptyState
          title="No workspaces to sync"
          description="No workspace sync engine is active for this signed-in account."
        />
      ) : (
        <CompanySectionCard>
          {rows.map((row) => (
            <CompanyStatusCard
              key={row.companyId}
              {...row}
              active={row.companyId === activeCompanyId}
            />
          ))}
        </CompanySectionCard>
      );
  }

  return (
    <SettingsSection {...searchableSetting("company-sync")} icon={<CloudIcon className="size-4" />}>
      {lacksCrossTabLeadership ? (
        <div className="mb-3 rounded-xl border border-warning/20 bg-warning/5 px-4 py-3 text-xs text-warning-foreground">
          This browser does not support cross-tab sync leadership. Each open tab may run its own
          engine.
        </div>
      ) : null}
      {content}
    </SettingsSection>
  );
}
