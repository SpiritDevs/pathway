import type { EnvironmentId } from "@spiritdevs/contracts";
import type { CompanyId, CompanyPermission } from "@spiritdevs/contracts/company";
import {
  EnvironmentCommandId,
  type EnvironmentCommand,
  type EnvironmentCommandArgs,
  type EnvironmentCommandKind,
  type EnvironmentCommandState,
} from "@spiritdevs/contracts/cloudProject";
import { ConvexClient } from "convex/browser";
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
  readonly close: () => Promise<void>;
}

export function makeEnvironmentControlClient(options: {
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
  readonly client?: EnvironmentControlConvexClient;
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
    close: () => (ownsClient ? client.close() : Promise.resolve()),
  };
}
