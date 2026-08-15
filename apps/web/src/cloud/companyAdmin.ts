import type {
  CompanyId,
  CompanyInvitationId,
  MembershipId,
  RoleAssignmentId,
  RoleAssignmentScope,
  RoleId,
  TeamId,
} from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

import { randomUUID } from "../lib/utils";
import type { ConvexAuthTokenFetcher } from "./syncTransport";

type ConvexArgs = Record<string, unknown>;

export function newCompanyDomainId(now = Date.now(), random = randomUUID()): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  return [
    timestamp.slice(0, 8),
    timestamp.slice(8, 12),
    `7${random.slice(15, 18)}`,
    random.slice(19, 23),
    random.slice(24),
  ].join("-");
}

export interface CompanyAdminConvexClient {
  readonly query: (reference: FunctionReference<"query">, args: ConvexArgs) => Promise<unknown>;
  readonly mutation: (
    reference: FunctionReference<"mutation">,
    args: ConvexArgs,
  ) => Promise<unknown>;
  readonly action: (reference: FunctionReference<"action">, args: ConvexArgs) => Promise<unknown>;
  readonly setAuth: (fetchToken: ConvexAuthTokenFetcher) => void;
  readonly close: () => Promise<void>;
}

const queryReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"query", Request, Response>(name);
const mutationReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"mutation", Request, Response>(name);
const actionReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"action", Request, Response>(name);

export interface CurrentCompanySummary {
  readonly id: CompanyId;
  readonly membershipId: MembershipId;
  readonly isOwner: boolean;
}

export interface CompanyInvitationSummary {
  readonly id: CompanyInvitationId;
  readonly email: string;
  readonly state: "pending" | "accepted" | "revoked" | "expired";
  readonly expiresAt: number;
  readonly teamIds: ReadonlyArray<TeamId>;
  readonly roleIds: ReadonlyArray<RoleId>;
  readonly deliveryAttempt: number;
  readonly lastDeliveryAt: number | null;
}

interface TeamCreateArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly id: TeamId;
  readonly name: string;
  readonly description?: string;
}

interface TeamUpdateArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly teamId: TeamId;
  readonly name?: string;
  readonly description?: string;
}

interface RoleCreateArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly id: RoleId;
  readonly name: string;
  readonly description?: string;
  readonly permissions: ReadonlyArray<string>;
}

interface RoleUpdateArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly roleId: RoleId;
  readonly name?: string;
  readonly description?: string;
  readonly permissions?: ReadonlyArray<string>;
}

interface InvitationCreateArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly id: CompanyInvitationId;
  readonly email: string;
  readonly teamIds: ReadonlyArray<TeamId>;
  readonly roleIds: ReadonlyArray<RoleId>;
}

export const COMPANY_ADMIN_FUNCTION_REFERENCES = {
  listMine: queryReference<{}, ReadonlyArray<CurrentCompanySummary>>("companies:listMine"),
  listInvitations: queryReference<
    { readonly companyId: CompanyId },
    ReadonlyArray<CompanyInvitationSummary>
  >("invitations:list"),
  createInvitation: actionReference<
    InvitationCreateArgs,
    { readonly id: CompanyInvitationId; readonly expiresAt: number }
  >("invitations:create"),
  resendInvitation: actionReference<
    { readonly companyId: CompanyId; readonly invitationId: CompanyInvitationId },
    null
  >("invitations:resend"),
  revokeInvitation: mutationReference<
    { readonly companyId: CompanyId; readonly invitationId: CompanyInvitationId },
    null
  >("invitations:revoke"),
  setMembershipState: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly membershipId: MembershipId;
      readonly state: "active" | "locked";
    },
    null
  >("memberships:setState"),
  removeMembership: mutationReference<
    { readonly companyId: CompanyId; readonly membershipId: MembershipId },
    null
  >("memberships:remove"),
  createTeam: mutationReference<TeamCreateArgs, null>("teams:create"),
  updateTeam: mutationReference<TeamUpdateArgs, null>("teams:update"),
  archiveTeam: mutationReference<{ readonly companyId: CompanyId; readonly teamId: TeamId }, null>(
    "teams:archive",
  ),
  addTeamMember: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly teamId: TeamId;
      readonly membershipId: MembershipId;
    },
    null
  >("teams:addMember"),
  removeTeamMember: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly teamId: TeamId;
      readonly membershipId: MembershipId;
    },
    null
  >("teams:removeMember"),
  createRole: mutationReference<RoleCreateArgs, null>("roles:create"),
  updateRole: mutationReference<RoleUpdateArgs, null>("roles:update"),
  removeRole: mutationReference<{ readonly companyId: CompanyId; readonly roleId: RoleId }, null>(
    "roles:remove",
  ),
  assignRole: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly id: RoleAssignmentId;
      readonly membershipId: MembershipId;
      readonly assignment: { readonly roleId: RoleId; readonly scope: RoleAssignmentScope };
    },
    null
  >("roles:assign"),
  unassignRole: mutationReference<
    { readonly companyId: CompanyId; readonly assignmentId: RoleAssignmentId },
    null
  >("roles:unassign"),
} as const;

const FRIENDLY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "not-authenticated": "Sign in to manage this company.",
  "not-a-member": "You are not an active member of this company.",
  "permission-denied": "You do not have permission to perform this action.",
  "already-a-member": "That person is already a member of this company.",
  "invitation-exists": "An invitation with that identifier already exists.",
  "invitation-consumed": "This invitation has already been accepted.",
  "invitation-revoked": "This invitation has been revoked.",
  "invitation-expired": "This invitation has expired.",
  "invitation-delivery-unconfigured": "This deployment has no invitation mailer configured.",
  "cloud-sync-disabled": "Company administration is not enabled on this deployment.",
};

export class CompanyAdminError extends Error {
  readonly code: string | null;

  constructor(options: { readonly code: string | null; readonly message: string }) {
    super(options.message);
    this.name = "CompanyAdminError";
    this.code = options.code;
  }
}

export function mapCompanyAdminError(error: unknown): CompanyAdminError {
  if (error instanceof CompanyAdminError) return error;
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const data = error.data as Record<string, unknown>;
    const code = typeof data["code"] === "string" ? data["code"] : null;
    const backendMessage = typeof data["message"] === "string" ? data["message"] : null;
    return new CompanyAdminError({
      code,
      message:
        (code === null ? undefined : FRIENDLY_ERROR_MESSAGES[code]) ??
        backendMessage ??
        "Company administration failed.",
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const offline =
    typeof navigator !== "undefined" && navigator.onLine === false
      ? "You appear to be offline. Company changes require a connection."
      : null;
  return new CompanyAdminError({
    code: null,
    message: offline ?? (message || "Company administration failed."),
  });
}

export interface CompanyAdminClient {
  readonly listMine: () => Promise<ReadonlyArray<CurrentCompanySummary>>;
  readonly listInvitations: (
    companyId: CompanyId,
  ) => Promise<ReadonlyArray<CompanyInvitationSummary>>;
  readonly createInvitation: (args: InvitationCreateArgs) => Promise<void>;
  readonly resendInvitation: (args: {
    readonly companyId: CompanyId;
    readonly invitationId: CompanyInvitationId;
  }) => Promise<void>;
  readonly revokeInvitation: (args: {
    readonly companyId: CompanyId;
    readonly invitationId: CompanyInvitationId;
  }) => Promise<void>;
  readonly setMembershipState: (args: {
    readonly companyId: CompanyId;
    readonly membershipId: MembershipId;
    readonly state: "active" | "locked";
  }) => Promise<void>;
  readonly removeMembership: (args: {
    readonly companyId: CompanyId;
    readonly membershipId: MembershipId;
  }) => Promise<void>;
  readonly createTeam: (args: TeamCreateArgs) => Promise<void>;
  readonly updateTeam: (args: TeamUpdateArgs) => Promise<void>;
  readonly archiveTeam: (args: {
    readonly companyId: CompanyId;
    readonly teamId: TeamId;
  }) => Promise<void>;
  readonly addTeamMember: (args: {
    readonly companyId: CompanyId;
    readonly teamId: TeamId;
    readonly membershipId: MembershipId;
  }) => Promise<void>;
  readonly removeTeamMember: (args: {
    readonly companyId: CompanyId;
    readonly teamId: TeamId;
    readonly membershipId: MembershipId;
  }) => Promise<void>;
  readonly createRole: (args: RoleCreateArgs) => Promise<void>;
  readonly updateRole: (args: RoleUpdateArgs) => Promise<void>;
  readonly removeRole: (args: {
    readonly companyId: CompanyId;
    readonly roleId: RoleId;
  }) => Promise<void>;
  readonly assignRole: (args: {
    readonly companyId: CompanyId;
    readonly id: RoleAssignmentId;
    readonly membershipId: MembershipId;
    readonly assignment: { readonly roleId: RoleId; readonly scope: RoleAssignmentScope };
  }) => Promise<void>;
  readonly unassignRole: (args: {
    readonly companyId: CompanyId;
    readonly assignmentId: RoleAssignmentId;
  }) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function makeCompanyAdminClient(options: {
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
  readonly client?: CompanyAdminConvexClient;
}): CompanyAdminClient {
  const ownsClient = options.client === undefined;
  const client: CompanyAdminConvexClient = options.client ?? new ConvexClient(options.convexUrl);
  client.setAuth(options.fetchToken);

  const call = async <A>(operation: () => Promise<unknown>): Promise<A> => {
    try {
      return (await operation()) as A;
    } catch (error) {
      throw mapCompanyAdminError(error);
    }
  };
  const query = <A>(reference: FunctionReference<"query">, args: ConvexArgs) =>
    call<A>(() => client.query(reference, args));
  const mutation = (reference: FunctionReference<"mutation">, args: ConvexArgs) =>
    call<null>(() => client.mutation(reference, args)).then(() => undefined);
  const action = (reference: FunctionReference<"action">, args: ConvexArgs) =>
    call<unknown>(() => client.action(reference, args)).then(() => undefined);

  return {
    listMine: () => query(COMPANY_ADMIN_FUNCTION_REFERENCES.listMine, {}),
    listInvitations: (companyId) =>
      query(COMPANY_ADMIN_FUNCTION_REFERENCES.listInvitations, { companyId }),
    createInvitation: (args) => action(COMPANY_ADMIN_FUNCTION_REFERENCES.createInvitation, args),
    resendInvitation: (args) => action(COMPANY_ADMIN_FUNCTION_REFERENCES.resendInvitation, args),
    revokeInvitation: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.revokeInvitation, args),
    setMembershipState: (args) =>
      mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.setMembershipState, args),
    removeMembership: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.removeMembership, args),
    createTeam: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.createTeam, args),
    updateTeam: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.updateTeam, args),
    archiveTeam: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.archiveTeam, args),
    addTeamMember: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.addTeamMember, args),
    removeTeamMember: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.removeTeamMember, args),
    createRole: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.createRole, args),
    updateRole: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.updateRole, args),
    removeRole: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.removeRole, args),
    assignRole: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.assignRole, args),
    unassignRole: (args) => mutation(COMPANY_ADMIN_FUNCTION_REFERENCES.unassignRole, args),
    close: () => (ownsClient ? client.close() : Promise.resolve()),
  };
}
