import type { AccountKind } from "@spiritdevs/client-runtime/profile";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";

type ConvexArgs = Record<string, unknown>;

function provisioningErrorDetails(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (typeof error !== "object" || error === null) return { code: "", message: "" };
  const data = (error as { data?: unknown }).data;
  const code =
    typeof data === "object" &&
    data !== null &&
    typeof (data as { code?: unknown }).code === "string"
      ? (data as { code: string }).code
      : "";
  const dataMessage =
    typeof data === "object" &&
    data !== null &&
    typeof (data as { message?: unknown }).message === "string"
      ? (data as { message: string }).message
      : "";
  return { code, message: dataMessage || (error instanceof Error ? error.message : "") };
}

/** Keeps setup failures actionable without exposing raw Convex diagnostics or request identifiers. */
export function onboardingProvisioningErrorMessage(error: unknown): string {
  const { code, message } = provisioningErrorDetails(error);
  if (code === "not-authenticated" || /signed-in Convex session|unauthenticated/iu.test(message)) {
    return "Your session expired while setting up the workspace. Sign in again and retry.";
  }
  if (
    /ArgumentValidationError|extra field|Could not find public function|not a registered function/iu.test(
      message,
    )
  ) {
    return "Pathway Cloud is still updating. Wait a moment, then try again.";
  }
  if (/Failed to fetch|fetch failed|NetworkError|network request failed/iu.test(message)) {
    return "We could not reach Pathway Cloud. Check your connection and try again.";
  }
  return code && message ? message : "We could not create your workspace. Try again.";
}

export interface OnboardingWorkspaceProvisioningArgs extends ConvexArgs {
  readonly workspaceKind: "personal" | "organization";
  readonly workspaceName?: string;
}

interface OnboardingProvisioningClient {
  readonly setAuth: (token: string) => void;
  readonly mutation: (
    reference: FunctionReference<"mutation">,
    args: ConvexArgs,
  ) => Promise<unknown>;
}

interface OnboardingWorkspaceValidationClient {
  readonly setAuth: (token: string) => void;
  readonly query: (
    reference: FunctionReference<"query">,
    args: ConvexArgs,
  ) => Promise<ReadonlyArray<unknown>>;
}

const provisionCurrentUserReference = makeFunctionReference<
  "mutation",
  OnboardingWorkspaceProvisioningArgs,
  unknown
>("companies:provisionCurrentUser");

const listCurrentUserWorkspacesReference = makeFunctionReference<
  "query",
  ConvexArgs,
  ReadonlyArray<unknown>
>("companies:listMine");

export function onboardingWorkspaceProvisioningArgs(
  accountKind: AccountKind,
  companyName: string,
): OnboardingWorkspaceProvisioningArgs {
  if (accountKind === "individual") return { workspaceKind: "personal" };
  const workspaceName = companyName.trim();
  return workspaceName.length === 0
    ? { workspaceKind: "organization" }
    : { workspaceKind: "organization", workspaceName };
}

/** One authenticated mutation; mobile does not retain another Convex connection after onboarding. */
export async function provisionOnboardingWorkspace(options: {
  readonly convexUrl: string;
  readonly fetchToken: () => Promise<string | null>;
  readonly args: OnboardingWorkspaceProvisioningArgs;
  readonly client?: OnboardingProvisioningClient;
}): Promise<void> {
  const token = await options.fetchToken();
  if (token === null) {
    throw new Error("A signed-in Convex session is required to provision a workspace.");
  }
  const client = options.client ?? new ConvexHttpClient(options.convexUrl);
  client.setAuth(token);
  await client.mutation(provisionCurrentUserReference, options.args);
}

/** A successful empty catalog is the only authoritative signal that onboarding needs recovery. */
export async function hasUsableOnboardingWorkspace(options: {
  readonly convexUrl: string;
  readonly fetchToken: () => Promise<string | null>;
  readonly client?: OnboardingWorkspaceValidationClient;
}): Promise<boolean> {
  const token = await options.fetchToken();
  if (token === null) {
    throw new Error("A signed-in Convex session is required to validate a workspace.");
  }
  const client = options.client ?? new ConvexHttpClient(options.convexUrl);
  client.setAuth(token);
  return (await client.query(listCurrentUserWorkspacesReference, {})).length > 0;
}

/** Clerk's completion marker must only become visible after Convex has a matching workspace. */
export async function completeOnboardingAfterWorkspaceProvision(options: {
  readonly provisionWorkspace: () => Promise<void>;
  readonly persistCompletedProfile: () => Promise<void>;
}): Promise<void> {
  await options.provisionWorkspace();
  await options.persistCompletedProfile();
}
