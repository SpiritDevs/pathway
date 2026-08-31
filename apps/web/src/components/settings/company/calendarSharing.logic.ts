/**
 * Presentation logic for the calendar sharing settings page.
 *
 * Two axes decide who reads a calendar, and the page has to keep them apart: the sharing level
 * widens a calendar to a team or the company for anyone holding `calendar.readAll`, while a grant
 * names one member. Neither reaches an event marked private, and neither substitutes for the
 * viewer's own `calendar.read`.
 */
import type { Calendar, CalendarSharing } from "@spiritdevs/contracts";
import type { MembershipId, TeamId } from "@spiritdevs/contracts/company";

import type { CalendarGrantSummary, CalendarOwnerGroup } from "../../../cloud/calendarSharing";
import type { CompanyMemberRow } from "./companySettings.logic";

export interface CalendarSharingOption {
  readonly value: CalendarSharing;
  readonly label: string;
  readonly description: string;
}

export const CALENDAR_SHARING_OPTIONS: ReadonlyArray<CalendarSharingOption> = [
  {
    value: "private",
    label: "Private",
    description: "Only you, plus anyone you name in a grant.",
  },
  {
    value: "team",
    label: "One team",
    description:
      "Members of the chosen team who hold “See every shared calendar”. Grants still reach everyone else.",
  },
  {
    value: "company",
    label: "Whole company",
    description:
      "Any member who holds “See every shared calendar”. Grants still reach everyone else.",
  },
];

const SHARING_RANK: Readonly<Record<CalendarSharing, number>> = {
  private: 0,
  team: 1,
  company: 2,
};

export const MIRRORED_CALENDAR_LOCK_REASON =
  "Mirrored Google calendars stay private. Share one with a grant instead.";

export interface CalendarSharingRow {
  readonly calendar: Calendar;
  readonly isOwnCalendar: boolean;
  readonly isMirrored: boolean;
  /** Grants can be added and revoked by the owner, or by a holder of `company.manage`. */
  readonly canManageGrants: boolean;
  /** The sharing level is the owner's alone, and mirrored calendars do not have one to set. */
  readonly canChangeSharing: boolean;
  readonly sharingSummary: string;
  readonly sharingLockReason: string | null;
}

export interface CalendarOwnerSection {
  readonly ownerMembershipId: MembershipId;
  readonly ownerName: string;
  readonly isCurrentMember: boolean;
  readonly calendars: ReadonlyArray<CalendarSharingRow>;
}

export function calendarSharingSummary(
  calendar: Pick<Calendar, "sharing" | "teamId">,
  teamNames: ReadonlyMap<TeamId, string>,
): string {
  if (calendar.sharing === "company") return "Shared with the whole company";
  if (calendar.sharing === "team") {
    const teamName = calendar.teamId === null ? null : (teamNames.get(calendar.teamId) ?? null);
    return teamName === null ? "Shared with one team" : `Shared with ${teamName}`;
  }
  return "Private";
}

function sharingLockReason(input: {
  readonly isMirrored: boolean;
  readonly isOwnCalendar: boolean;
  readonly canManageGrants: boolean;
  readonly ownerName: string;
}): string | null {
  if (input.isMirrored) return MIRRORED_CALENDAR_LOCK_REASON;
  if (input.isOwnCalendar) return null;
  return input.canManageGrants
    ? `Only ${input.ownerName} can change the sharing level. You can still add and remove grants.`
    : `Only ${input.ownerName} can share this calendar.`;
}

/**
 * Owner groups as the page renders them: the signed-in member first, then the backend's
 * name order. Sharing a work calendar while withholding a personal one is the case that
 * matters, so a calendar never leaves its owner's group.
 */
export function deriveCalendarSections(input: {
  readonly groups: ReadonlyArray<CalendarOwnerGroup>;
  readonly currentMembershipId: MembershipId | null;
  readonly canManageCompany: boolean;
  readonly teamNames: ReadonlyMap<TeamId, string>;
}): ReadonlyArray<CalendarOwnerSection> {
  return input.groups
    .map((group): CalendarOwnerSection => {
      const isCurrentMember =
        input.currentMembershipId !== null && group.ownerMembershipId === input.currentMembershipId;
      return {
        ownerMembershipId: group.ownerMembershipId,
        ownerName: group.ownerName,
        isCurrentMember,
        calendars: [...group.calendars]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((calendar): CalendarSharingRow => {
            const isMirrored = calendar.kind === "google";
            const canManageGrants = isCurrentMember || input.canManageCompany;
            return {
              calendar,
              isOwnCalendar: isCurrentMember,
              isMirrored,
              canManageGrants,
              canChangeSharing: isCurrentMember && !isMirrored,
              sharingSummary: calendarSharingSummary(calendar, input.teamNames),
              sharingLockReason: sharingLockReason({
                isMirrored,
                isOwnCalendar: isCurrentMember,
                canManageGrants,
                ownerName: group.ownerName,
              }),
            };
          }),
      };
    })
    .filter((section) => section.calendars.length > 0)
    .sort(
      (a, b) =>
        Number(b.isCurrentMember) - Number(a.isCurrentMember) ||
        a.ownerName.localeCompare(b.ownerName),
    );
}

export interface GrantCandidate {
  readonly membershipId: MembershipId;
  readonly displayName: string;
  readonly email: string;
}

/** Active members who could still be granted this calendar: not its owner, not already granted. */
export function grantCandidates(input: {
  readonly members: ReadonlyArray<CompanyMemberRow>;
  readonly ownerMembershipId: MembershipId;
  readonly grants: ReadonlyArray<CalendarGrantSummary>;
}): ReadonlyArray<GrantCandidate> {
  const granted = new Set(input.grants.map((grant) => grant.granteeMembershipId));
  return input.members
    .filter(
      (member) =>
        member.state === "active" &&
        member.id !== input.ownerMembershipId &&
        !granted.has(member.id),
    )
    .map((member) => ({
      membershipId: member.id,
      displayName: member.displayName || member.email,
      email: member.email,
    }));
}

/**
 * Revoking tombstones the calendar row for that grantee, so their client drops the calendar and
 * every event under it. The copy promises no undo, because there is none to promise.
 */
export function revokeConfirmMessage(input: {
  readonly calendarName: string;
  readonly granteeName: string;
}): string {
  return [
    `Revoke ${input.granteeName}’s access to “${input.calendarName}”?`,
    `This takes effect immediately and cascades: ${input.granteeName} loses this calendar and every event on it as soon as their app syncs.`,
    "There is no undo. Sharing it again is a new grant.",
  ].join("\n");
}

function sharingLevelPhrase(
  sharing: CalendarSharing,
  teamId: TeamId | null,
  teamNames: ReadonlyMap<TeamId, string>,
): string {
  if (sharing === "company") return "the whole company";
  if (sharing === "team") {
    const teamName = teamId === null ? null : (teamNames.get(teamId) ?? null);
    return teamName === null ? "one team" : teamName;
  }
  return "private";
}

/**
 * Narrowing a sharing level cascades exactly like a revoke for everyone who was reading through
 * the old level, so it is confirmed too. Null when the change only widens access, or is a no-op.
 */
export function sharingChangeConfirmMessage(input: {
  readonly calendarName: string;
  readonly from: CalendarSharing;
  readonly fromTeamId: TeamId | null;
  readonly to: CalendarSharing;
  readonly toTeamId: TeamId | null;
  readonly teamNames: ReadonlyMap<TeamId, string>;
}): string | null {
  const narrows =
    SHARING_RANK[input.to] < SHARING_RANK[input.from] ||
    (input.from === "team" && input.to === "team" && input.fromTeamId !== input.toTeamId);
  if (!narrows) return null;
  const from = sharingLevelPhrase(input.from, input.fromTeamId, input.teamNames);
  const to = sharingLevelPhrase(input.to, input.toTeamId, input.teamNames);
  return [
    `Narrow “${input.calendarName}” from ${from} to ${to}?`,
    "Anyone reading it through the old sharing level loses this calendar and its events as soon as their app syncs.",
    "Grants you named stay in place.",
  ].join("\n");
}
