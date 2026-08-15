import type { IssueImportRun } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

import type { ConvexArgs, ConvexAuthTokenFetcher } from "./syncTransport";

export interface IssueImportConvexClient {
  readonly mutation: (
    reference: FunctionReference<"mutation">,
    args: ConvexArgs,
  ) => Promise<unknown>;
  readonly onUpdate: (
    reference: FunctionReference<"query">,
    args: ConvexArgs,
    callback: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => () => void;
  readonly setAuth: (fetchToken: ConvexAuthTokenFetcher) => void;
  readonly close: () => Promise<void>;
}

const mutationReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"mutation", Request, Response>(name);
const queryReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"query", Request, Response>(name);

export const ISSUE_IMPORT_FUNCTION_REFERENCES = {
  start: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly id: string;
      readonly sourceEnvironmentId: string;
      readonly selectedIssueKeyPrefix: string;
    },
    IssueImportRun
  >("issueImport:start"),
  get: queryReference<
    { readonly companyId: CompanyId; readonly runId: string },
    IssueImportRun | null
  >("issueImport:get"),
  abandon: mutationReference<
    { readonly companyId: CompanyId; readonly runId: string },
    IssueImportRun
  >("issueImport:abandon"),
} as const;

const FRIENDLY_ERRORS: Readonly<Record<string, string>> = {
  "not-authenticated": "Sign in to migrate issues.",
  "not-a-member": "You are not an active member of this company.",
  "permission-denied": "You need company.manage permission to migrate issues.",
  "company-not-empty": "This migration only runs when the cloud company has no issue data.",
  "environment-not-registered": "Link this environment to the company before migrating.",
  "import-already-running": "Another issue migration is already running for this company.",
  "import-run-conflict": "This migration id belongs to a different import.",
  "invalid-import-state": "This migration can no longer be changed.",
};

export class IssueImportClientError extends Error {
  readonly code: string | null;

  constructor(code: string | null, message: string) {
    super(message);
    this.name = "IssueImportClientError";
    this.code = code;
  }
}

export function mapIssueImportClientError(error: unknown): IssueImportClientError {
  if (error instanceof IssueImportClientError) return error;
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const data = error.data as Record<string, unknown>;
    const code = typeof data["code"] === "string" ? data["code"] : null;
    const message = typeof data["message"] === "string" ? data["message"] : null;
    return new IssueImportClientError(
      code,
      (code === null ? undefined : FRIENDLY_ERRORS[code]) ??
        message ??
        "The issue migration request failed.",
    );
  }
  return new IssueImportClientError(
    null,
    typeof navigator !== "undefined" && navigator.onLine === false
      ? "You appear to be offline. Issue migration requires a cloud connection."
      : "The issue migration request failed.",
  );
}

export interface IssueImportClient {
  readonly start: (args: {
    readonly companyId: CompanyId;
    readonly id: string;
    readonly sourceEnvironmentId: string;
    readonly selectedIssueKeyPrefix: string;
  }) => Promise<IssueImportRun>;
  readonly subscribeRun: (
    args: { readonly companyId: CompanyId; readonly runId: string },
    onValue: (run: IssueImportRun | null) => void,
    onError: (error: IssueImportClientError) => void,
  ) => () => void;
  readonly abandon: (args: {
    readonly companyId: CompanyId;
    readonly runId: string;
  }) => Promise<IssueImportRun>;
  readonly close: () => Promise<void>;
}

export function makeIssueImportClient(options: {
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
  readonly client?: IssueImportConvexClient;
}): IssueImportClient {
  const ownsClient = options.client === undefined;
  const client = options.client ?? new ConvexClient(options.convexUrl);
  client.setAuth(options.fetchToken);

  const mutation = async <A>(reference: FunctionReference<"mutation">, args: ConvexArgs) => {
    try {
      return (await client.mutation(reference, args)) as A;
    } catch (error) {
      throw mapIssueImportClientError(error);
    }
  };

  return {
    start: (args) => mutation<IssueImportRun>(ISSUE_IMPORT_FUNCTION_REFERENCES.start, args),
    subscribeRun: (args, onValue, onError) =>
      client.onUpdate(
        ISSUE_IMPORT_FUNCTION_REFERENCES.get,
        args,
        (value) => onValue(value as IssueImportRun | null),
        (error) => onError(mapIssueImportClientError(error)),
      ),
    abandon: (args) => mutation<IssueImportRun>(ISSUE_IMPORT_FUNCTION_REFERENCES.abandon, args),
    close: () => (ownsClient ? client.close() : Promise.resolve()),
  };
}
