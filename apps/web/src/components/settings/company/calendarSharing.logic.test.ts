import { CalendarGrantId, CalendarId, type Calendar } from "@spiritdevs/contracts";
import { CompanyId, MembershipId, TeamId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import type { CalendarGrantSummary, CalendarOwnerGroup } from "../../../cloud/calendarSharing";
import {
  calendarSharingSummary,
  deriveCalendarSections,
  grantCandidates,
  revokeConfirmMessage,
  sharingChangeConfirmMessage,
  MIRRORED_CALENDAR_LOCK_REASON,
} from "./calendarSharing.logic";
import type { CompanyMemberRow } from "./companySettings.logic";

const COMPANY_ID = CompanyId.make("company-1");
const ALICE = MembershipId.make("membership-alice");
const BOB = MembershipId.make("membership-bob");
const CAROL = MembershipId.make("membership-carol");
const DESIGN = TeamId.make("team-design");
const TEAM_NAMES = new Map([[DESIGN, "Design"]]);

function calendar(id: string, overrides: Partial<Calendar> = {}): Calendar {
  return {
    id: CalendarId.make(id),
    companyId: COMPANY_ID,
    ownerMembershipId: ALICE,
    name: id,
    sharing: "private",
    teamId: null,
    kind: "pathway",
    accountId: null,
    googleCalendarId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Calendar;
}

function member(id: MembershipId, overrides: Partial<CompanyMemberRow> = {}): CompanyMemberRow {
  return {
    id,
    displayName: id,
    email: `${id}@example.com`,
    state: "active",
    isOwner: false,
    joinedAt: 1,
    teams: [],
    roles: [],
    ...overrides,
  } as CompanyMemberRow;
}

const aliceGroup: CalendarOwnerGroup = {
  ownerMembershipId: ALICE,
  ownerName: "Alice",
  calendars: [
    calendar("cal-work", { name: "Work", sharing: "team", teamId: DESIGN }),
    calendar("cal-personal", { name: "Personal" }),
  ],
};

const bobGroup: CalendarOwnerGroup = {
  ownerMembershipId: BOB,
  ownerName: "Bob",
  calendars: [
    calendar("cal-bob-google", {
      name: "bob@gmail.com",
      ownerMembershipId: BOB,
      kind: "google",
      googleCalendarId: "primary",
    }),
  ],
};

describe("calendarSharingSummary", () => {
  it("names the team a team-shared calendar reaches", () => {
    expect(calendarSharingSummary({ sharing: "team", teamId: DESIGN }, TEAM_NAMES)).toBe(
      "Shared with Design",
    );
    expect(calendarSharingSummary({ sharing: "team", teamId: null }, TEAM_NAMES)).toBe(
      "Shared with one team",
    );
    expect(calendarSharingSummary({ sharing: "company", teamId: null }, TEAM_NAMES)).toBe(
      "Shared with the whole company",
    );
    expect(calendarSharingSummary({ sharing: "private", teamId: null }, TEAM_NAMES)).toBe(
      "Private",
    );
  });
});

describe("deriveCalendarSections", () => {
  it("puts the signed-in member's calendars first and sorts each group by name", () => {
    const sections = deriveCalendarSections({
      groups: [bobGroup, aliceGroup],
      currentMembershipId: ALICE,
      canManageCompany: false,
      teamNames: TEAM_NAMES,
    });

    expect(sections.map((section) => section.ownerName)).toEqual(["Alice", "Bob"]);
    expect(sections[0]?.calendars.map((row) => row.calendar.name)).toEqual(["Personal", "Work"]);
    expect(sections[0]?.isCurrentMember).toBe(true);
  });

  it("lets the owner edit the sharing level and leaves someone else's calendar read-only", () => {
    const [mine, theirs] = deriveCalendarSections({
      groups: [aliceGroup, bobGroup],
      currentMembershipId: ALICE,
      canManageCompany: false,
      teamNames: TEAM_NAMES,
    });

    const work = mine?.calendars.find((row) => row.calendar.name === "Work");
    expect(work?.canChangeSharing).toBe(true);
    expect(work?.canManageGrants).toBe(true);
    expect(work?.sharingLockReason).toBeNull();
    expect(work?.sharingSummary).toBe("Shared with Design");

    const bobsMirror = theirs?.calendars[0];
    expect(bobsMirror?.canChangeSharing).toBe(false);
    expect(bobsMirror?.canManageGrants).toBe(false);
    expect(bobsMirror?.sharingLockReason).toBe(MIRRORED_CALENDAR_LOCK_REASON);
  });

  it("gives company.manage the grants on another member's calendar but not its sharing level", () => {
    const sections = deriveCalendarSections({
      groups: [bobGroup],
      currentMembershipId: ALICE,
      canManageCompany: true,
      teamNames: TEAM_NAMES,
    });

    const row = sections[0]?.calendars[0];
    expect(row?.canManageGrants).toBe(true);
    expect(row?.canChangeSharing).toBe(false);
  });

  it("keeps a mirrored calendar's sharing level locked even for its owner", () => {
    const sections = deriveCalendarSections({
      groups: [bobGroup],
      currentMembershipId: BOB,
      canManageCompany: false,
      teamNames: TEAM_NAMES,
    });

    const row = sections[0]?.calendars[0];
    expect(row?.isOwnCalendar).toBe(true);
    expect(row?.canManageGrants).toBe(true);
    expect(row?.canChangeSharing).toBe(false);
    expect(row?.sharingLockReason).toBe(MIRRORED_CALENDAR_LOCK_REASON);
  });

  it("drops owners whose calendars are all unreadable", () => {
    const sections = deriveCalendarSections({
      groups: [{ ownerMembershipId: CAROL, ownerName: "Carol", calendars: [] }],
      currentMembershipId: ALICE,
      canManageCompany: true,
      teamNames: TEAM_NAMES,
    });
    expect(sections).toEqual([]);
  });
});

describe("grantCandidates", () => {
  const members = [
    member(ALICE, { displayName: "Alice" }),
    member(BOB, { displayName: "Bob" }),
    member(CAROL, { displayName: "", state: "left" }),
  ];
  const grant: CalendarGrantSummary = {
    id: CalendarGrantId.make("grant-1"),
    granteeMembershipId: BOB,
    granteeName: "Bob",
    createdAt: 1,
  };

  it("excludes the owner, existing grantees, and members who have left", () => {
    expect(
      grantCandidates({ members, ownerMembershipId: ALICE, grants: [grant] }).map(
        (candidate) => candidate.membershipId,
      ),
    ).toEqual([]);
    expect(
      grantCandidates({ members, ownerMembershipId: ALICE, grants: [] }).map(
        (candidate) => candidate.membershipId,
      ),
    ).toEqual([BOB]);
  });

  it("falls back to the email when a member has no display name", () => {
    const [candidate] = grantCandidates({
      members: [member(CAROL, { displayName: "" })],
      ownerMembershipId: ALICE,
      grants: [],
    });
    expect(candidate?.displayName).toBe("membership-carol@example.com");
  });
});

describe("revokeConfirmMessage", () => {
  it("states the cascade and promises no undo", () => {
    const message = revokeConfirmMessage({ calendarName: "Work", granteeName: "Bob" });
    expect(message).toContain("Revoke Bob’s access to “Work”?");
    expect(message).toContain("every event on it");
    expect(message).toContain("There is no undo.");
  });
});

describe("sharingChangeConfirmMessage", () => {
  const base = { calendarName: "Work", teamNames: TEAM_NAMES };

  it("confirms every narrowing change", () => {
    expect(
      sharingChangeConfirmMessage({
        ...base,
        from: "company",
        fromTeamId: null,
        to: "team",
        toTeamId: DESIGN,
      }),
    ).toContain("Narrow “Work” from the whole company to Design?");
    expect(
      sharingChangeConfirmMessage({
        ...base,
        from: "team",
        fromTeamId: DESIGN,
        to: "private",
        toTeamId: null,
      }),
    ).toContain("to private?");
    expect(
      sharingChangeConfirmMessage({
        ...base,
        from: "team",
        fromTeamId: DESIGN,
        to: "team",
        toTeamId: TeamId.make("team-ops"),
      }),
    ).toContain("Narrow “Work”");
  });

  it("says grants survive a narrowing", () => {
    expect(
      sharingChangeConfirmMessage({
        ...base,
        from: "company",
        fromTeamId: null,
        to: "private",
        toTeamId: null,
      }),
    ).toContain("Grants you named stay in place.");
  });

  it("stays quiet when the change widens access or changes nothing", () => {
    expect(
      sharingChangeConfirmMessage({
        ...base,
        from: "private",
        fromTeamId: null,
        to: "company",
        toTeamId: null,
      }),
    ).toBeNull();
    expect(
      sharingChangeConfirmMessage({
        ...base,
        from: "team",
        fromTeamId: DESIGN,
        to: "team",
        toTeamId: DESIGN,
      }),
    ).toBeNull();
  });
});
