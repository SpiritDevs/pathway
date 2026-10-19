import type { Calendar, CalendarSharing } from "@spiritdevs/contracts";
import type { MembershipId, TeamId } from "@spiritdevs/contracts/company";
import {
  CalendarDaysIcon,
  LinkIcon,
  RefreshCwIcon,
  UserPlusIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  useCalendarSharingClient,
  type CalendarGrantSummary,
  type CalendarOwnerGroup,
  type CalendarSharingClient,
} from "../../../cloud/calendarSharing";
import { ensureLocalApi } from "../../../localApi";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Radio, RadioGroup } from "../../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import {
  CALENDAR_SHARING_OPTIONS,
  deriveCalendarSections,
  grantCandidates,
  revokeConfirmMessage,
  sharingChangeConfirmMessage,
  type CalendarSharingRow,
} from "./calendarSharing.logic";
import { deriveMemberRows, permissionGate } from "./companySettings.logic";
import {
  CompanySectionCard,
  CompanySettingsEmptyState,
  PermissionTooltip,
} from "./CompanySettingsShared";
import { CompanySettingsSheet } from "./CompanySettingsSheet";
import { useCompanySettings, type CompanySettings } from "./useCompanySettings";

function reportError(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The calendar change failed.",
    }),
  );
}

function CalendarSharingSheet({
  settings,
  client,
  row,
  open,
  onOpenChange,
  onSharingChanged,
}: {
  readonly settings: CompanySettings;
  readonly client: CalendarSharingClient | null;
  readonly row: CalendarSharingRow;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSharingChanged: () => Promise<void>;
}) {
  const { calendar } = row;
  const { companyId } = settings;
  const [grants, setGrants] = useState<ReadonlyArray<CalendarGrantSummary>>([]);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<CalendarSharing>(calendar.sharing);
  const [teamId, setTeamId] = useState<TeamId | null>(calendar.teamId);
  const [granteeId, setGranteeId] = useState<MembershipId | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const teams = useMemo(
    () => settings.directory.teams.filter((team) => team.archivedAt === null),
    [settings.directory.teams],
  );
  const teamNames = useMemo(
    () => new Map(settings.directory.teams.map((team) => [team.id, team.name])),
    [settings.directory.teams],
  );
  const members = useMemo(() => deriveMemberRows(settings.directory), [settings.directory]);
  const candidates = useMemo(
    () =>
      grantCandidates({
        members,
        ownerMembershipId: calendar.ownerMembershipId,
        grants,
      }),
    [calendar.ownerMembershipId, grants, members],
  );

  const refreshGrants = useCallback(async () => {
    if (client === null || companyId === null || !row.canManageGrants) {
      setGrants([]);
      return;
    }
    try {
      setGrants(await client.listGrants(companyId, calendar.id));
      setGrantsError(null);
    } catch (error) {
      setGrantsError(error instanceof Error ? error.message : "Could not load grants.");
    }
  }, [calendar.id, client, companyId, row.canManageGrants]);

  useEffect(() => {
    if (!open) return;
    void refreshGrants();
  }, [open, refreshGrants]);

  const sharingDirty = sharing !== calendar.sharing || teamId !== calendar.teamId;
  const sharingIncomplete = sharing === "team" && teamId === null;

  const saveSharing = async () => {
    if (client === null || companyId === null || pending !== null || sharingIncomplete) return;
    const confirmMessage = sharingChangeConfirmMessage({
      calendarName: calendar.name,
      from: calendar.sharing,
      fromTeamId: calendar.teamId,
      to: sharing,
      toTeamId: teamId,
      teamNames,
    });
    if (confirmMessage !== null) {
      const confirmed = await ensureLocalApi()
        .dialogs.confirm(confirmMessage, { variant: "destructive" })
        .catch(() => false);
      if (!confirmed) return;
    }
    setPending("sharing");
    try {
      await client.setSharing({
        companyId,
        calendarId: calendar.id,
        sharing,
        teamId: sharing === "team" ? teamId : null,
      });
      await onSharingChanged();
    } catch (error) {
      reportError("Could not change who this calendar reaches", error);
      setSharing(calendar.sharing);
      setTeamId(calendar.teamId);
    } finally {
      setPending(null);
    }
  };

  const share = async () => {
    if (client === null || companyId === null || granteeId === null || pending !== null) return;
    setPending("share");
    try {
      await client.share({
        companyId,
        calendarId: calendar.id,
        granteeMembershipId: granteeId,
      });
      setGranteeId(null);
      await refreshGrants();
    } catch (error) {
      reportError("Could not share this calendar", error);
    } finally {
      setPending(null);
    }
  };

  const revoke = async (grant: CalendarGrantSummary) => {
    if (client === null || companyId === null || pending !== null) return;
    const confirmed = await ensureLocalApi()
      .dialogs.confirm(
        revokeConfirmMessage({ calendarName: calendar.name, granteeName: grant.granteeName }),
        { variant: "destructive" },
      )
      .catch(() => false);
    if (!confirmed) return;
    setPending(grant.id);
    try {
      await client.revoke({
        companyId,
        calendarId: calendar.id,
        granteeMembershipId: grant.granteeMembershipId,
      });
      await refreshGrants();
    } catch (error) {
      reportError("Could not revoke access", error);
    } finally {
      setPending(null);
    }
  };

  return (
    <CompanySettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={calendar.name}
      description="A grant names this calendar, not everything its owner keeps. Viewers still need the calendar permission, and events marked private stay with their owner."
      footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{row.sharingSummary}</Badge>
        {row.isMirrored ? (
          <Badge variant="outline">
            <LinkIcon className="size-3" /> Mirrored from Google
          </Badge>
        ) : null}
        {row.isOwnCalendar ? null : (
          <span className="text-xs text-muted-foreground">Owned by another member</span>
        )}
      </div>

      <fieldset className="space-y-2" disabled={!row.canChangeSharing || pending !== null}>
        <legend className="text-xs font-medium">Sharing level</legend>
        <RadioGroup
          value={sharing}
          onValueChange={(value) => setSharing(value as CalendarSharing)}
          aria-label="Sharing level"
          className="gap-2"
        >
          {CALENDAR_SHARING_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-2 rounded-lg border p-2.5">
              <Radio
                value={option.value}
                disabled={option.value === "team" && teams.length === 0}
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{option.label}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {option.value === "team" && teams.length === 0
                    ? "No teams exist in this workspace yet."
                    : option.description}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {sharing === "team" && teams.length > 0 ? (
          <Select
            value={teamId ?? ""}
            onValueChange={(value) => setTeamId((value as TeamId | null) ?? null)}
          >
            <SelectTrigger size="sm">
              <SelectValue placeholder="Choose a team">
                {teams.find((team) => team.id === teamId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </fieldset>
      {row.sharingLockReason ? (
        <p className="text-[11px] text-muted-foreground">{row.sharingLockReason}</p>
      ) : (
        <div className="flex justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={!sharingDirty || sharingIncomplete || pending !== null}
            onClick={() => void saveSharing()}
          >
            {pending === "sharing" ? "Saving…" : "Save sharing level"}
          </Button>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">People with a grant</legend>
        {!row.canManageGrants ? (
          <p className="text-[11px] text-muted-foreground">
            Only {calendar.name}&rsquo;s owner, or someone who can manage the company, can see and
            edit its grants.
          </p>
        ) : (
          <>
            {grantsError ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                <span>{grantsError}</span>
                <Button size="xs" variant="ghost" onClick={() => void refreshGrants()}>
                  Retry
                </Button>
              </div>
            ) : null}
            {grants.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Nobody holds a grant on this calendar.
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                {grants.map((grant) => (
                  <div
                    key={grant.id}
                    className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{grant.granteeName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        Shared {new Date(grant.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive"
                      disabled={pending !== null}
                      onClick={() => void revoke(grant)}
                    >
                      {pending === grant.id ? "Revoking…" : "Revoke"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Select
                value={granteeId ?? ""}
                onValueChange={(value) => setGranteeId((value as MembershipId | null) ?? null)}
                disabled={candidates.length === 0}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder="Choose a member">
                    {
                      candidates.find((candidate) => candidate.membershipId === granteeId)
                        ?.displayName
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.membershipId} value={candidate.membershipId}>
                      {candidate.displayName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="sm"
                disabled={granteeId === null || pending !== null}
                onClick={() => void share()}
              >
                <UserPlusIcon className="size-3.5" />
                {pending === "share" ? "Sharing…" : "Share"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              A grant lets one member read every detail on this calendar, except events marked
              private. It never stands in for their own calendar permission.
            </p>
          </>
        )}
      </fieldset>
    </CompanySettingsSheet>
  );
}

function CalendarRow({
  row,
  onManage,
}: {
  readonly row: CalendarSharingRow;
  readonly onManage: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-medium">{row.calendar.name}</h3>
          <Badge variant={row.calendar.sharing === "private" ? "secondary" : "info"}>
            {row.sharingSummary}
          </Badge>
          {row.isMirrored ? <Badge variant="outline">Google</Badge> : null}
        </div>
        {row.sharingLockReason ? (
          <p className="mt-1 text-xs text-muted-foreground">{row.sharingLockReason}</p>
        ) : null}
      </div>
      <PermissionTooltip
        tooltip={
          row.canManageGrants
            ? null
            : "You can see this calendar, but only its owner or someone who can manage the company may share it."
        }
      >
        <Button size="xs" variant="outline" disabled={!row.canManageGrants} onClick={onManage}>
          <UsersRoundIcon className="size-3" /> Sharing
        </Button>
      </PermissionTooltip>
    </div>
  );
}

export function CompanyCalendarsSection({ settings }: { readonly settings: CompanySettings }) {
  const client = useCalendarSharingClient();
  const [groups, setGroups] = useState<ReadonlyArray<CalendarOwnerGroup>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openCalendarId, setOpenCalendarId] = useState<Calendar["id"] | null>(null);

  const { companyId } = settings;
  const refresh = useCallback(async () => {
    if (client === null || companyId === null) {
      setGroups([]);
      return;
    }
    setLoading(true);
    try {
      setGroups(await client.listGroupedByOwner(companyId));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load calendars.");
    } finally {
      setLoading(false);
    }
  }, [client, companyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const teamNames = useMemo(
    () => new Map(settings.directory.teams.map((team) => [team.id, team.name])),
    [settings.directory.teams],
  );
  const sections = useMemo(
    () =>
      deriveCalendarSections({
        groups,
        currentMembershipId: settings.currentMembership?.membershipId ?? null,
        canManageCompany: permissionGate(settings.permissions, "company.manage").enabled,
        teamNames,
      }),
    [groups, settings.currentMembership?.membershipId, settings.permissions, teamNames],
  );
  const openRow =
    sections
      .flatMap((section) => section.calendars)
      .find((row) => row.calendar.id === openCalendarId) ?? null;

  return (
    <>
      <SettingsSection
        id="calendar-sharing"
        title="Calendars"
        icon={<CalendarDaysIcon className="size-4" />}
        headerAction={
          <Button size="xs" variant="ghost" disabled={loading} onClick={() => void refresh()}>
            <RefreshCwIcon className="size-3" /> Refresh
          </Button>
        }
      >
        {loadError ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
            <span>{loadError}</span>
            <Button size="xs" variant="ghost" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        ) : null}
        <CompanySectionCard>
          {sections.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {loading ? "Loading calendars…" : "No calendars you can read yet."}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.ownerMembershipId}>
                <div className="border-b bg-muted/30 px-4 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {section.isCurrentMember ? "Your calendars" : section.ownerName}
                </div>
                {section.calendars.map((row) => (
                  <CalendarRow
                    key={row.calendar.id}
                    row={row}
                    onManage={() => setOpenCalendarId(row.calendar.id)}
                  />
                ))}
              </div>
            ))
          )}
        </CompanySectionCard>
        <p className="@xl/settings:px-4 max-w-xl px-3 text-[11px] leading-[1.5] text-muted-foreground">
          Members only see the calendars listed here. Reading any of them also needs the calendar
          permission on their role — a grant alone is never enough — and{" "}
          <span className="font-medium">See every shared calendar</span> reaches team- and
          company-shared calendars without one. Events marked private stay with their owner
          throughout.
        </p>
      </SettingsSection>

      {openRow === null ? null : (
        <CalendarSharingSheet
          key={openRow.calendar.id}
          settings={settings}
          client={client}
          row={openRow}
          open
          onOpenChange={(open) => {
            if (!open) setOpenCalendarId(null);
          }}
          onSharingChanged={refresh}
        />
      )}
    </>
  );
}

export function CompanyCalendarsPanel() {
  const settings = useCompanySettings();

  if (settings.isAuthLoaded && !settings.isSignedIn) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Sign in to manage calendar sharing"
          description="Calendars, their sharing levels, and their grants are available after you sign in."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.activeCompany === null || settings.companyId === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="No active workspace"
          description="Your workspace is still being prepared. Try again in a moment."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.replica === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Workspace data is syncing"
          description="Calendar sharing will appear when this workspace is ready."
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <CompanyCalendarsSection settings={settings} />
    </SettingsPageContainer>
  );
}
