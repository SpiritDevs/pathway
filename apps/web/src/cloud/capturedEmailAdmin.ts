/** Authenticated Convex writes for synchronized captured-email administration. */
import { useAuth } from "@clerk/react";
import type { EnvironmentId } from "@spiritdevs/contracts";
import type { EmailMessageId, EmailTagId, TrustedEmailSenderId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { useEffect, useMemo } from "react";

import { newCompanyDomainId } from "./companyAdmin";
import { resolveCloudSyncConvexUrl } from "./publicConfig";
import type { ConvexAuthTokenFetcher } from "./syncTransport";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";

type Args = Record<string, unknown>;
const mutationReference = <Request extends Args>(name: string) =>
  makeFunctionReference<"mutation", Request, null>(name);

export interface CapturedEmailIdentity {
  readonly environmentId: EnvironmentId;
  readonly messageId: EmailMessageId;
}

const REFERENCES = {
  createTag: mutationReference<{
    companyId: CompanyId;
    id: EmailTagId;
    name: string;
    color: string;
  }>("emailTags:create"),
  updateTag: mutationReference<{
    companyId: CompanyId;
    tagId: EmailTagId;
    name?: string;
    color?: string;
  }>("emailTags:update"),
  deleteTag: mutationReference<{ companyId: CompanyId; tagId: EmailTagId }>("emailTags:remove"),
  setTag: mutationReference<{
    companyId: CompanyId;
    environmentId: EnvironmentId;
    messageId: EmailMessageId;
    tagId: EmailTagId;
    present: boolean;
  }>("capturedEmails:setTag"),
  deleteMessages: mutationReference<{
    companyId: CompanyId;
    messages: ReadonlyArray<CapturedEmailIdentity>;
  }>("capturedEmails:remove"),
  trustSender: mutationReference<{
    companyId: CompanyId;
    id: TrustedEmailSenderId;
    address: string;
  }>("trustedEmailSenders:trust"),
  removeTrustedSender: mutationReference<{
    companyId: CompanyId;
    trustedSenderId: TrustedEmailSenderId;
  }>("trustedEmailSenders:remove"),
} as const;

export interface CapturedEmailAdminConvexClient {
  readonly mutation: (reference: FunctionReference<"mutation">, args: Args) => Promise<unknown>;
  readonly setAuth: (fetchToken: ConvexAuthTokenFetcher) => void;
  readonly close: () => Promise<void>;
}

export interface CapturedEmailAdminClient {
  readonly createTag: (input: {
    companyId: CompanyId;
    name: string;
    color: string;
  }) => Promise<EmailTagId>;
  readonly updateTag: (input: {
    companyId: CompanyId;
    tagId: EmailTagId;
    name?: string;
    color?: string;
  }) => Promise<void>;
  readonly deleteTag: (companyId: CompanyId, tagId: EmailTagId) => Promise<void>;
  readonly setTag: (
    companyId: CompanyId,
    message: CapturedEmailIdentity,
    tagId: EmailTagId,
    present: boolean,
  ) => Promise<void>;
  readonly deleteMessages: (
    companyId: CompanyId,
    messages: ReadonlyArray<CapturedEmailIdentity>,
  ) => Promise<void>;
  readonly trustSender: (companyId: CompanyId, address: string) => Promise<TrustedEmailSenderId>;
  readonly removeTrustedSender: (
    companyId: CompanyId,
    trustedSenderId: TrustedEmailSenderId,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function makeCapturedEmailAdminClient(options: {
  convexUrl: string;
  fetchToken: ConvexAuthTokenFetcher;
  client?: CapturedEmailAdminConvexClient;
}): CapturedEmailAdminClient {
  const ownsClient = options.client === undefined;
  const client = options.client ?? new ConvexClient(options.convexUrl);
  client.setAuth(options.fetchToken);
  const mutate = (reference: FunctionReference<"mutation">, args: Args) =>
    client.mutation(reference, args).then(() => undefined);
  return {
    createTag: async ({ companyId, name, color }) => {
      const id = newCompanyDomainId() as EmailTagId;
      await mutate(REFERENCES.createTag, { companyId, id, name, color });
      return id;
    },
    updateTag: (input) => mutate(REFERENCES.updateTag, input),
    deleteTag: (companyId, tagId) => mutate(REFERENCES.deleteTag, { companyId, tagId }),
    setTag: (companyId, message, tagId, present) =>
      mutate(REFERENCES.setTag, { companyId, ...message, tagId, present }),
    deleteMessages: (companyId, messages) =>
      mutate(REFERENCES.deleteMessages, { companyId, messages }),
    trustSender: async (companyId, address) => {
      const id = newCompanyDomainId() as TrustedEmailSenderId;
      await mutate(REFERENCES.trustSender, { companyId, id, address });
      return id;
    },
    removeTrustedSender: (companyId, trustedSenderId) =>
      mutate(REFERENCES.removeTrustedSender, { companyId, trustedSenderId }),
    close: () => (ownsClient ? client.close() : Promise.resolve()),
  };
}

/** Null when company sync is unavailable; environment-local email actions can still use RPC. */
export function useCapturedEmailAdmin(): CapturedEmailAdminClient | null {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const convexUrl = resolveCloudSyncConvexUrl();
  const client = useMemo(
    () =>
      convexUrl === null || !isSignedIn
        ? null
        : makeCapturedEmailAdminClient({
            convexUrl,
            fetchToken: makeClerkConvexTokenFetcher(getToken),
          }),
    [convexUrl, getToken, isSignedIn],
  );
  useEffect(() => () => void client?.close(), [client]);
  return client;
}
