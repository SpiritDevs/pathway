import type { EnvironmentCloudRegistrationInfo, EnvironmentId } from "@spiritdevs/contracts";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import type { CompanyId, CompanyPermission } from "@spiritdevs/contracts/company";
import {
  EnvironmentCommandId,
  type EnvironmentCommand,
  type EnvironmentCommandArgs,
  type EnvironmentCommandKind,
  type EnvironmentCommandState,
} from "@spiritdevs/contracts/cloudProject";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

import { newCompanyDomainId } from "./companyAdmin";
import type { ConvexArgs, ConvexAuthTokenFetcher } from "./syncTransport";

export const DEFAULT_ENVIRONMENT_COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
export const ENVIRONMENT_COMMAND_LIST_LIMIT = 500;

export type EnvironmentCommandRecord = Omit<EnvironmentCommand, "companyId">;

export interface IssueEnvironmentCommandArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly cloudProjectId: null;
  readonly kind: EnvironmentCommandKind;
  readonly args: EnvironmentCommandArgs;
  readonly ttlMs?: number;
}

interface IssueEnvironmentCommandRequest extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly id: EnvironmentCommandId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly cloudProjectId: null;
  readonly kind: EnvironmentCommandKind;
  readonly args: EnvironmentCommandArgs;
  readonly ttlMs: number;
}

export interface IssuedConnectGrant {
  readonly id: string;
  readonly token: string;
  readonly environmentId: EnvironmentId;
  readonly membershipId: string;
  readonly permission: CompanyPermission;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface EnvironmentControlConvexClient {
  readonly query: (reference: FunctionReference<"query">, args: ConvexArgs) => Promise<unknown>;
  readonly mutation: (
    reference: FunctionReference<"mutation">,
    args: ConvexArgs,
  ) => Promise<unknown>;
  readonly action: (reference: FunctionReference<"action">, args: ConvexArgs) => Promise<unknown>;
  readonly onUpdate: (
    reference: FunctionReference<"query">,
    args: ConvexArgs,
    callback: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => () => void;
  readonly setAuth: (fetchToken: ConvexAuthTokenFetcher) => void;
  readonly close: () => Promise<void>;
}

export interface EnvironmentControlHttpClient {
  readonly mutation: (
    reference: FunctionReference<"mutation">,
    args: ConvexArgs,
  ) => Promise<unknown>;
  readonly setAuth: (token: string) => void;
}

const queryReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"query", Request, Response>(name);
const mutationReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"mutation", Request, Response>(name);
const actionReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"action", Request, Response>(name);

export const ENVIRONMENT_CONTROL_FUNCTION_REFERENCES = {
  issueCommand: mutationReference<IssueEnvironmentCommandRequest, null>(
    "environmentCommands:issue",
  ),
  listCommands: queryReference<
    {
      readonly companyId: CompanyId;
      readonly state?: EnvironmentCommandState;
      readonly limit?: number;
    },
    ReadonlyArray<EnvironmentCommandRecord>
  >("environmentCommands:list"),
  cancelCommand: mutationReference<
    { readonly companyId: CompanyId; readonly commandId: EnvironmentCommandId },
    null
  >("environmentCommands:cancel"),
  issueConnectGrant: actionReference<
    {
      readonly companyId: CompanyId;
      readonly environmentId: EnvironmentId;
      readonly permission: CompanyPermission;
    },
    IssuedConnectGrant
  >("connectGrants:issue"),
  deactivateEnvironment: mutationReference<
    { readonly companyId: CompanyId; readonly environmentId: EnvironmentId },
    null
  >("environments:deactivate"),
  registerEnvironment: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly environmentId: EnvironmentId;
      readonly publicKeyThumbprint: string;
      readonly descriptor: EnvironmentCloudRegistrationInfo["descriptor"];
      readonly relayLinkState: EnvironmentCloudRegistrationInfo["relayLinkState"];
      readonly managedEndpointAvailable: boolean;
      readonly serviceRoleIds: ReadonlyArray<string>;
      readonly teamIds: ReadonlyArray<string>;
    },
    null
  >("environments:register"),
  renameEnvironment: mutationReference<
    {
      readonly environmentId: EnvironmentId;
      readonly displayName: string | null;
    },
    null
  >("relayPersistence:renameEnvironmentLink"),
  moveProjectToCompany: mutationReference<
    {
      readonly fromCompanyId: CompanyId;
      readonly toCompanyId: CompanyId;
      readonly projectId: string;
      readonly statusMapping: ReadonlyArray<{ readonly from: string; readonly to: string }>;
      readonly labelMapping: ReadonlyArray<{ readonly from: string; readonly to: string }>;
    },
    {
      readonly movedIssues: number;
      readonly movedMilestones: number;
      readonly movedBindings: number;
      readonly movedThreads: number;
      readonly movedEmails: number;
      readonly movedIssueAssets: number;
      readonly canceledAutomationJobs: number;
      readonly detachedSlackWatches: number;
      readonly droppedLabels: number;
    }
  >("projectMigration:moveProjectToCompany"),
  provisionPersonalWorkspace: mutationReference<
    { readonly workspaceKind: "personal" },
    { readonly id: CompanyId }
  >("companies:provisionCurrentUser"),
  createCompanyProject: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly name: string;
      readonly description?: string;
    },
    string
  >("cloudProjects:createCompanyProject"),
  ensureEnvironmentProject: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly environmentId: EnvironmentId;
      readonly localProjectId: string;
      readonly localWorkspaceRoot: string | null;
      readonly name: string;
    },
    string
  >("cloudProjects:ensureEnvironmentProject"),
  setPreferredEnvironmentBinding: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly cloudProjectId: string;
      readonly bindingId: string;
    },
    null
  >("cloudProjects:setPreferredEnvironmentBinding"),
  releaseEnvironmentProject: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly environmentId: EnvironmentId;
      readonly localProjectId: string;
    },
    null
  >("cloudProjects:releaseEnvironmentProject"),
  deleteCompanyProject: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly cloudProjectId: string;
    },
    null
  >("cloudProjects:deleteCompanyProject"),
} as const;

const FRIENDLY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "not-authenticated": "Sign in to control company environments.",
  "not-a-member": "You are not an active member of this company.",
  "permission-denied": "You do not have permission to perform this action.",
  "environment-not-registered": "This environment is no longer actively registered.",
  "entity-not-found": "The environment or command no longer exists.",
  "invalid-command-state": "That command can no longer be canceled.",
  "command-expired": "The command expired before it could be completed.",
  "cloud-sync-disabled": "Environment control is not enabled on this deployment.",
};

export class EnvironmentControlError extends Error {
  readonly code: string | null;

  constructor(options: { readonly code: string | null; readonly message: string }) {
    super(options.message);
    this.name = "EnvironmentControlError";
    this.code = options.code;
  }
}

export function mapEnvironmentControlError(error: unknown): EnvironmentControlError {
  if (error instanceof EnvironmentControlError) return error;
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const data = error.data as Record<string, unknown>;
    const code = typeof data["code"] === "string" ? data["code"] : null;
    const backendMessage = typeof data["message"] === "string" ? data["message"] : null;
    return new EnvironmentControlError({
      code,
      message:
        (code === null ? undefined : FRIENDLY_ERROR_MESSAGES[code]) ??
        backendMessage ??
        "Environment control failed.",
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const offline =
    typeof navigator !== "undefined" && navigator.onLine === false
      ? "You appear to be offline. Environment control requires a connection."
      : null;
  return new EnvironmentControlError({
    code: null,
    message: offline ?? (message || "Environment control failed."),
  });
}

export interface EnvironmentControlClient {
  readonly issueCommand: (args: IssueEnvironmentCommandArgs) => Promise<EnvironmentCommandId>;
  readonly listCommands: (companyId: CompanyId) => Promise<ReadonlyArray<EnvironmentCommandRecord>>;
  readonly subscribeCommands: (
    companyId: CompanyId,
    onValue: (commands: ReadonlyArray<EnvironmentCommandRecord>) => void,
    onError: (error: EnvironmentControlError) => void,
  ) => () => void;
  readonly cancelCommand: (args: {
    readonly companyId: CompanyId;
    readonly commandId: EnvironmentCommandId;
  }) => Promise<void>;
  readonly issueConnectGrant: (args: {
    readonly companyId: CompanyId;
    readonly environmentId: EnvironmentId;
    readonly permission: CompanyPermission;
  }) => Promise<IssuedConnectGrant>;
  readonly deactivateEnvironment: (args: {
    readonly companyId: CompanyId;
    readonly environmentId: EnvironmentId;
  }) => Promise<void>;
  readonly registerEnvironment: (args: {
    readonly companyId: CompanyId;
    readonly info: EnvironmentCloudRegistrationInfo;
    readonly serviceRoleIds: ReadonlyArray<string>;
  }) => Promise<void>;
  readonly renameEnvironment: (args: {
    readonly environmentId: EnvironmentId;
    readonly displayName: string | null;
  }) => Promise<void>;
  /**
   * Moves a project and everything filed against it to another company.
   *
   * Destructive: issues are re-keyed under the destination prefix and the old keys are gone.
   */
  readonly moveProjectToCompany: (args: {
    readonly fromCompanyId: CompanyId;
    readonly toCompanyId: CompanyId;
    readonly projectId: string;
    readonly statusMapping: ReadonlyArray<{ readonly from: string; readonly to: string }>;
    readonly labelMapping: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  }) => Promise<{
    readonly movedIssues: number;
    readonly movedMilestones: number;
    readonly movedBindings: number;
    readonly movedThreads: number;
    readonly movedEmails: number;
    readonly movedIssueAssets: number;
    readonly canceledAutomationJobs: number;
    readonly detachedSlackWatches: number;
    readonly droppedLabels: number;
  }>;
  /**
   * The signed-in person's personal workspace, created on the spot when they have none.
   *
   * A personal workspace is permanent (ADR 0011) and is where side projects and anything not work
   * belongs, but an account provisioned straight into an organization — or one whose workspace was
   * converted before that rule existed — has none to choose. The mutation is idempotent, so this
   * doubles as the lookup.
   */
  readonly provisionPersonalWorkspace: () => Promise<CompanyId>;
  /** Creates a project the company owns before any machine has a checkout of it. */
  readonly createCompanyProject: (args: {
    readonly companyId: CompanyId;
    readonly name: string;
    readonly description?: string;
  }) => Promise<void>;
  readonly ensureEnvironmentProject: (args: {
    readonly companyId: CompanyId;
    /**
     * Only the four fields the mutation sends. Narrower than `EnvironmentProject` on purpose: a
     * caller that has just created a project holds those four and nothing else, and widening the
     * parameter to the full shell would force it to invent a repository identity and a script list.
     */
    readonly project: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot" | "title">;
  }) => Promise<void>;
  readonly setPreferredEnvironmentBinding: (args: {
    readonly companyId: CompanyId;
    readonly cloudProjectId: string;
    readonly bindingId: string;
  }) => Promise<void>;
  readonly releaseEnvironmentProject: (args: {
    readonly companyId: CompanyId;
    readonly environmentId: EnvironmentId;
    readonly localProjectId: string;
  }) => Promise<void>;
  readonly deleteCompanyProject: (args: {
    readonly companyId: CompanyId;
    readonly cloudProjectId: string;
  }) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function makeEnvironmentControlClient(options: {
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
  readonly client?: EnvironmentControlConvexClient;
  readonly httpClient?: EnvironmentControlHttpClient;
}): EnvironmentControlClient {
  const ownsClient = options.client === undefined;
  const client: EnvironmentControlConvexClient =
    options.client ?? new ConvexClient(options.convexUrl);
  client.setAuth(options.fetchToken);

  const call = async <A>(operation: () => Promise<unknown>): Promise<A> => {
    try {
      return (await operation()) as A;
    } catch (error) {
      throw mapEnvironmentControlError(error);
    }
  };
  const query = <A>(reference: FunctionReference<"query">, args: ConvexArgs) =>
    call<A>(() => client.query(reference, args));
  const mutation = (reference: FunctionReference<"mutation">, args: ConvexArgs) =>
    call<null>(() => client.mutation(reference, args)).then(() => undefined);
  const mutationResult = <A>(reference: FunctionReference<"mutation">, args: ConvexArgs) =>
    call<A>(() => client.mutation(reference, args));
  const authenticatedHttpMutation = async (
    reference: FunctionReference<"mutation">,
    args: ConvexArgs,
  ) => {
    const token = await options.fetchToken({ forceRefreshToken: false });
    if (!token) {
      throw new EnvironmentControlError({
        code: "not-authenticated",
        message: FRIENDLY_ERROR_MESSAGES["not-authenticated"]!,
      });
    }
    const http = options.httpClient ?? new ConvexHttpClient(options.convexUrl);
    http.setAuth(token);
    await call<null>(() => http.mutation(reference, args));
  };
  const useHttpMutation = options.client === undefined || options.httpClient !== undefined;
  const registrationMutation = useHttpMutation
    ? (args: ConvexArgs) =>
        authenticatedHttpMutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.registerEnvironment, args)
    : (args: ConvexArgs) =>
        mutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.registerEnvironment, args);
  const cloudProjectMutation = (reference: FunctionReference<"mutation">, args: ConvexArgs) =>
    useHttpMutation ? authenticatedHttpMutation(reference, args) : mutation(reference, args);
  const action = <A>(reference: FunctionReference<"action">, args: ConvexArgs) =>
    call<A>(() => client.action(reference, args));

  return {
    issueCommand: async (args) => {
      const id = EnvironmentCommandId.make(newCompanyDomainId());
      await mutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.issueCommand, {
        ...args,
        id,
        ttlMs: args.ttlMs ?? DEFAULT_ENVIRONMENT_COMMAND_TTL_MS,
      });
      return id;
    },
    listCommands: (companyId) =>
      query(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.listCommands, {
        companyId,
        limit: ENVIRONMENT_COMMAND_LIST_LIMIT,
      }),
    subscribeCommands: (companyId, onValue, onError) =>
      client.onUpdate(
        ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.listCommands,
        { companyId, limit: ENVIRONMENT_COMMAND_LIST_LIMIT },
        (value) => onValue(value as ReadonlyArray<EnvironmentCommandRecord>),
        (error) => onError(mapEnvironmentControlError(error)),
      ),
    cancelCommand: (args) => mutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.cancelCommand, args),
    issueConnectGrant: (args) =>
      action(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.issueConnectGrant, args),
    deactivateEnvironment: (args) =>
      mutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.deactivateEnvironment, args),
    registerEnvironment: ({ companyId, info, serviceRoleIds }) =>
      registrationMutation({
        companyId,
        environmentId: info.descriptor.environmentId,
        publicKeyThumbprint: info.publicKeyThumbprint,
        descriptor: info.descriptor,
        relayLinkState: info.relayLinkState,
        managedEndpointAvailable: info.managedEndpointAvailable,
        serviceRoleIds,
        teamIds: [],
      }),
    renameEnvironment: (args) =>
      useHttpMutation
        ? authenticatedHttpMutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.renameEnvironment, args)
        : mutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.renameEnvironment, args),
    moveProjectToCompany: (args) =>
      mutationResult(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.moveProjectToCompany, args),
    provisionPersonalWorkspace: () =>
      mutationResult<{ readonly id: CompanyId }>(
        ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.provisionPersonalWorkspace,
        { workspaceKind: "personal" },
      ).then((summary) => summary.id),
    createCompanyProject: (args) =>
      mutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.createCompanyProject, args),
    ensureEnvironmentProject: ({ companyId, project }) =>
      mutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.ensureEnvironmentProject, {
        companyId,
        environmentId: project.environmentId,
        localProjectId: project.id,
        localWorkspaceRoot: project.workspaceRoot,
        name: project.title,
      }),
    setPreferredEnvironmentBinding: (args) =>
      mutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.setPreferredEnvironmentBinding, args),
    releaseEnvironmentProject: (args) =>
      cloudProjectMutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.releaseEnvironmentProject, args),
    deleteCompanyProject: (args) =>
      cloudProjectMutation(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES.deleteCompanyProject, args),
    close: () => (ownsClient ? client.close() : Promise.resolve()),
  };
}
