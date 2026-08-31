/**
 * Authenticated Convex reads and writes for calendar sharing.
 *
 * Sharing is administered online rather than from the replica: the settings surface needs the
 * grant rows themselves, and a grantee only ever replicates the calendars they can already read.
 */
import { useAuth } from "@clerk/react";
import type { Calendar, CalendarGrantId, CalendarId, CalendarSharing } from "@spiritdevs/contracts";
import type { CompanyId, MembershipId, TeamId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { useEffect, useMemo } from "react";

import { mapCompanyAdminError, newCompanyDomainId } from "./companyAdmin";
import { resolveCloudSyncConvexUrl } from "./publicConfig";
import type { ConvexAuthTokenFetcher } from "./syncTransport";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";

type Args = Record<string, unknown>;

/** One calendar the signed-in member may read, as returned by `calendars:listGroupedByOwner`. */
export interface CalendarOwnerGroup {
  readonly ownerMembershipId: MembershipId;
  readonly ownerName: string;
  readonly calendars: ReadonlyArray<Calendar>;
}

/** One grant on a calendar. The grantee's name is snapshotted by the query, not by the replica. */
export interface CalendarGrantSummary {
  readonly id: CalendarGrantId;
  readonly granteeMembershipId: MembershipId;
  readonly granteeName: string;
  readonly createdAt: number;
}

const queryReference = <Request extends Args, Response>(name: string) =>
  makeFunctionReference<"query", Request, Response>(name);
const mutationReference = <Request extends Args>(name: string) =>
  makeFunctionReference<"mutation", Request, null>(name);

const REFERENCES = {
  listGroupedByOwner: queryReference<{ companyId: CompanyId }, ReadonlyArray<CalendarOwnerGroup>>(
    "calendars:listGroupedByOwner",
  ),
  listGrants: queryReference<
    { companyId: CompanyId; calendarId: CalendarId },
    ReadonlyArray<CalendarGrantSummary>
  >("calendars:listGrants"),
  share: mutationReference<{
    companyId: CompanyId;
    id: CalendarGrantId;
    calendarId: CalendarId;
    granteeMembershipId: MembershipId;
  }>("calendars:share"),
  revoke: mutationReference<{
    companyId: CompanyId;
    calendarId: CalendarId;
    granteeMembershipId: MembershipId;
  }>("calendars:revoke"),
  update: mutationReference<{
    companyId: CompanyId;
    calendarId: CalendarId;
    sharing: CalendarSharing;
    teamId: TeamId | null;
  }>("calendars:update"),
} as const;

export interface CalendarSharingConvexClient {
  readonly query: (reference: FunctionReference<"query">, args: Args) => Promise<unknown>;
  readonly mutation: (reference: FunctionReference<"mutation">, args: Args) => Promise<unknown>;
  readonly setAuth: (fetchToken: ConvexAuthTokenFetcher) => void;
  readonly close: () => Promise<void>;
}

export interface CalendarSharingClient {
  readonly listGroupedByOwner: (companyId: CompanyId) => Promise<ReadonlyArray<CalendarOwnerGroup>>;
  readonly listGrants: (
    companyId: CompanyId,
    calendarId: CalendarId,
  ) => Promise<ReadonlyArray<CalendarGrantSummary>>;
  readonly share: (input: {
    readonly companyId: CompanyId;
    readonly calendarId: CalendarId;
    readonly granteeMembershipId: MembershipId;
  }) => Promise<CalendarGrantId>;
  readonly revoke: (input: {
    readonly companyId: CompanyId;
    readonly calendarId: CalendarId;
    readonly granteeMembershipId: MembershipId;
  }) => Promise<void>;
  /** Sharing level only; the calendar's name is edited on the calendar surface. */
  readonly setSharing: (input: {
    readonly companyId: CompanyId;
    readonly calendarId: CalendarId;
    readonly sharing: CalendarSharing;
    readonly teamId: TeamId | null;
  }) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function makeCalendarSharingClient(options: {
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
  readonly client?: CalendarSharingConvexClient;
}): CalendarSharingClient {
  const ownsClient = options.client === undefined;
  const client: CalendarSharingConvexClient = options.client ?? new ConvexClient(options.convexUrl);
  client.setAuth(options.fetchToken);

  const call = async <A>(operation: () => Promise<unknown>): Promise<A> => {
    try {
      return (await operation()) as A;
    } catch (error) {
      throw mapCompanyAdminError(error);
    }
  };
  const mutate = (reference: FunctionReference<"mutation">, args: Args) =>
    call<null>(() => client.mutation(reference, args)).then(() => undefined);

  return {
    listGroupedByOwner: (companyId) =>
      call<ReadonlyArray<CalendarOwnerGroup>>(() =>
        client.query(REFERENCES.listGroupedByOwner, { companyId }),
      ),
    listGrants: (companyId, calendarId) =>
      call<ReadonlyArray<CalendarGrantSummary>>(() =>
        client.query(REFERENCES.listGrants, { companyId, calendarId }),
      ),
    share: async ({ companyId, calendarId, granteeMembershipId }) => {
      const id = newCompanyDomainId() as CalendarGrantId;
      await mutate(REFERENCES.share, { companyId, id, calendarId, granteeMembershipId });
      return id;
    },
    revoke: (input) => mutate(REFERENCES.revoke, input),
    setSharing: (input) => mutate(REFERENCES.update, input),
    close: () => (ownsClient ? client.close() : Promise.resolve()),
  };
}

/** Null until the member is signed in to a deployment that has company sync configured. */
export function useCalendarSharingClient(): CalendarSharingClient | null {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const convexUrl = resolveCloudSyncConvexUrl();
  const client = useMemo(
    () =>
      convexUrl === null || !isSignedIn
        ? null
        : makeCalendarSharingClient({
            convexUrl,
            fetchToken: makeClerkConvexTokenFetcher(getToken),
          }),
    [convexUrl, getToken, isSignedIn],
  );
  useEffect(() => () => void client?.close(), [client]);
  return client;
}
