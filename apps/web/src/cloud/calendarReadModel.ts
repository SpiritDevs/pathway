/**
 * Reactive web bindings for the framework-neutral synced calendar read model.
 *
 * Narrowing and ordering live in `client-runtime/sync/calendarReadModel`, the way the issue domain
 * does it, so the browser's live view and the server's durable replica cannot disagree about what
 * the calendar domain is. What is added here is the atoms, the viewer's own membership, and the
 * `calendar.read` gate the nav rail and the surface both consult.
 *
 * @module cloud/calendarReadModel
 */
import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_SYNCED_CALENDAR,
  syncedCalendarFromEntities,
  type CalendarAccountEntity,
  type CalendarEntity,
  type CalendarEventEntity,
  type CalendarEventLinkEntity,
  type SyncedCalendarReadModel,
} from "@spiritdevs/client-runtime/sync";
import type { CalendarId } from "@spiritdevs/contracts";
import { grantedCompanyPermissions } from "@spiritdevs/contracts/cloudSync";
import {
  hasCompanyPermission,
  resolveEffectivePermissions,
  type CompanyId,
  type CompanyPermission,
  type EffectiveCompanyPermissions,
  type MembershipId,
} from "@spiritdevs/contracts/company";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import {
  companyDirectoryFromReplicaValues,
  type CompanyDirectoryEntities,
} from "../components/settings/company/companySettings.logic";
import { activeCompanyIdAtom, scopedCompanyRegistryReplicasAtom } from "./activeCompany";
import {
  companyRegistryMembershipIdsAtom,
  companyRegistryReplicasAtom,
} from "./companyRegistryReplica";

export {
  EMPTY_SYNCED_CALENDAR,
  calendarEventsByCalendar,
  type SyncedCalendarReadModel,
} from "@spiritdevs/client-runtime/sync";
export type {
  CalendarAccountEntity,
  CalendarEntity,
  CalendarEventEntity,
  CalendarEventLinkEntity,
} from "@spiritdevs/client-runtime/sync";

export const syncedCalendarAtom = Atom.make(
  (get): SyncedCalendarReadModel =>
    syncedCalendarFromEntities(
      [...get(scopedCompanyRegistryReplicasAtom).values()].flatMap((replica) => [
        ...replica.view.values(),
      ]),
    ),
).pipe(Atom.withLabel("cloud-sync:calendar"));

export const syncedCalendarsAtom = Atom.make((get) => get(syncedCalendarAtom).calendars).pipe(
  Atom.withLabel("cloud-sync:calendars"),
);
export const syncedCalendarEventsAtom = Atom.make(
  (get) => get(syncedCalendarAtom).calendarEvents,
).pipe(Atom.withLabel("cloud-sync:calendar-events"));
export const syncedCalendarAccountsAtom = Atom.make(
  (get) => get(syncedCalendarAtom).calendarAccounts,
).pipe(Atom.withLabel("cloud-sync:calendar-accounts"));
export const syncedCalendarEventLinksAtom = Atom.make(
  (get) => get(syncedCalendarAtom).calendarEventLinks,
).pipe(Atom.withLabel("cloud-sync:calendar-event-links"));

function sameCompanyIds(
  current: ReadonlyArray<CompanyId>,
  next: ReadonlyArray<CompanyId>,
): boolean {
  return current.length === next.length && current.every((id, index) => id === next[index]);
}

const calendarAlertCompanyIdsAtom = Atom.make((get) => [
  ...get(scopedCompanyRegistryReplicasAtom).keys(),
]).pipe(Atom.withEquality(sameCompanyIds), Atom.withLabel("cloud-sync:calendar-alert-company-ids"));

export function useSyncedCalendar(): SyncedCalendarReadModel {
  return useAtomValue(syncedCalendarAtom);
}

export function useSyncedCalendars(): ReadonlyArray<CalendarEntity> {
  return useAtomValue(syncedCalendarsAtom);
}

export function useSyncedCalendarEvents(): ReadonlyArray<CalendarEventEntity> {
  return useAtomValue(syncedCalendarEventsAtom);
}

export function useSyncedCalendarAccounts(): ReadonlyArray<CalendarAccountEntity> {
  return useAtomValue(syncedCalendarAccountsAtom);
}

export function useSyncedCalendarEventLinks(): ReadonlyArray<CalendarEventLinkEntity> {
  return useAtomValue(syncedCalendarEventLinksAtom);
}

export function useCalendarAlertCompanyIds(): ReadonlyArray<CompanyId> {
  return useAtomValue(calendarAlertCompanyIdsAtom);
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/**
 * Who is looking, and whether the feature is theirs to use.
 *
 * `canRead` mirrors what `sync/visibility.ts` asks server-side: `calendar.read` granted *anywhere*
 * — company-wide or inside any one team — because the feature is either on for a member or it is
 * not, and per-calendar reach is the grant's job rather than this flag's. Ownership is the second
 * half of the same answer: `calendars.update` refuses anyone but a Pathway calendar's owner, so a
 * calendar the viewer does not own is drawn read-only for the same reason a mirror is.
 */
export interface CalendarViewer {
  readonly companyId: CompanyId | null;
  readonly membershipId: MembershipId | null;
  /**
   * `true` when `calendar.read` is granted, `false` when it is known not to be, and `null` while
   * the replica has yet to say — the nav rail keeps its row during `null` rather than flickering it
   * away on every reconnect.
   */
  readonly canRead: boolean | null;
}

export function calendarViewerFromDirectory(input: {
  readonly companyId: CompanyId | null;
  readonly membershipId: MembershipId | null;
  readonly directory: CompanyDirectoryEntities;
  readonly isOwner: boolean;
}): CalendarViewer {
  const { companyId, membershipId } = input;
  if (companyId === null || membershipId === null) {
    return { companyId, membershipId, canRead: null };
  }
  if (input.isOwner) return { companyId, membershipId, canRead: true };

  const assignments = input.directory.roleAssignments.filter(
    (assignment) => assignment.membershipId === membershipId,
  );
  const roleById = new Map(input.directory.roles.map((role) => [role.id, role]));
  // A role the replica has not delivered yet would read as "no permissions", which is the one
  // answer that must not be given: it would hide a surface the member does have.
  if (assignments.some((assignment) => !roleById.has(assignment.roleId))) {
    return { companyId, membershipId, canRead: null };
  }
  const effective = resolveEffectivePermissions({
    isOwner: false,
    roles: input.directory.roles.map((role) => ({
      id: role.id,
      permissions: [...grantedCompanyPermissions(role.permissions)],
    })),
    assignments: assignments.map((assignment) => ({
      roleId: assignment.roleId,
      scope: assignment.scope,
    })),
  });
  return { companyId, membershipId, canRead: grantedAnywhere(effective, "calendar.read") };
}

/**
 * Whether a permission is granted *anywhere* — company-wide, or inside any one team.
 *
 * Written here rather than imported because the contract exposes the company and record checks and
 * the backend keeps this weaker third one to itself. It is the right question for a feature gate:
 * `calendar.read` at any scope means the surface is the member's to use, and which calendars they
 * reach inside it is a grant's business rather than this flag's.
 */
function grantedAnywhere(
  effective: EffectiveCompanyPermissions,
  permission: CompanyPermission,
): boolean {
  if (hasCompanyPermission(effective, permission)) return true;
  for (const permissions of effective.teams.values()) {
    if (permissions.has(permission)) return true;
  }
  return false;
}

/** The viewer for the selected company. `All companies` has no single membership, so it answers null. */
export function useCalendarViewer(): CalendarViewer {
  const companyId = useAtomValue(activeCompanyIdAtom);
  const replicas = useAtomValue(companyRegistryReplicasAtom);
  const membershipIds = useAtomValue(companyRegistryMembershipIdsAtom);
  return useMemo(() => {
    const replica = companyId === null ? undefined : replicas.get(companyId);
    const membershipId = companyId === null ? null : (membershipIds.get(companyId) ?? null);
    const directory = companyDirectoryFromReplicaValues(replica?.view.values() ?? []);
    return calendarViewerFromDirectory({
      companyId,
      membershipId,
      directory,
      isOwner:
        directory.company?.owners.some((owner) => owner.membershipId === membershipId) ?? false,
    });
  }, [companyId, membershipIds, replicas]);
}

/** Calendars the viewer may write to: their own, and Pathway-owned rather than mirrored. */
export function ownedCalendarIds(
  calendars: ReadonlyArray<CalendarEntity>,
  membershipId: MembershipId | null,
): ReadonlySet<CalendarId> {
  const owned = new Set<CalendarId>();
  if (membershipId === null) return owned;
  for (const calendar of calendars) {
    if (calendar.kind === "pathway" && calendar.ownerMembershipId === membershipId) {
      owned.add(calendar.id);
    }
  }
  return owned;
}

export const EMPTY_SYNCED_CALENDAR_MODEL: SyncedCalendarReadModel = EMPTY_SYNCED_CALENDAR;
