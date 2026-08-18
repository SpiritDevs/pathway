/** Browser client for Convex-authorized, direct-to-UploadThing issue attachments. */
import { useAuth } from "@clerk/react";
import type { ChatAttachmentId, IssueId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { useEffect, useMemo, useState } from "react";

import { resolveCloudSyncConvexUrl } from "./publicConfig";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";
import type { ConvexArgs, ConvexAuthTokenFetcher } from "./syncTransport";

export interface IssueAttachmentConvexClient {
  readonly action: (reference: FunctionReference<"action">, args: ConvexArgs) => Promise<unknown>;
  readonly query: (reference: FunctionReference<"query">, args: ConvexArgs) => Promise<unknown>;
  readonly setAuth: (fetchToken: ConvexAuthTokenFetcher) => void;
  readonly close: () => Promise<void>;
}

export interface ReplicaIssueAttachment {
  readonly attachmentId: ChatAttachmentId;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly url: string;
}

interface PrepareResult {
  readonly attachmentId: ChatAttachmentId;
  readonly state: "upload-required" | "ready";
  readonly uploadUrl: string | null;
}

const actionReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"action", Request, Response>(name);
const queryReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"query", Request, Response>(name);

export const ISSUE_ATTACHMENT_FUNCTION_REFERENCES = {
  prepareUpload: actionReference<
    {
      readonly companyId: CompanyId;
      readonly issueId: IssueId;
      readonly uploads: ReadonlyArray<{
        readonly clientRequestId: string;
        readonly fileName: string;
        readonly mimeType: string;
        readonly byteSize: number;
        readonly checksum: string;
      }>;
    },
    ReadonlyArray<PrepareResult>
  >("issueAttachments:prepareUpload"),
  finalizeUpload: actionReference<
    { readonly companyId: CompanyId; readonly attachmentId: ChatAttachmentId },
    { readonly status: "ready" | "already-ready" }
  >("issueAttachments:finalizeUpload"),
  urls: queryReference<
    {
      readonly companyId: CompanyId;
      readonly issueId: IssueId;
      readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
    },
    ReadonlyArray<ReplicaIssueAttachment>
  >("issueAttachments:urls"),
} as const;

export class IssueAttachmentClientError extends Error {
  readonly code: string | null;

  constructor(code: string | null, message: string) {
    super(message);
    this.name = "IssueAttachmentClientError";
    this.code = code;
  }
}

export function mapIssueAttachmentClientError(error: unknown): IssueAttachmentClientError {
  if (error instanceof IssueAttachmentClientError) return error;
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const data = error.data as Record<string, unknown>;
    return new IssueAttachmentClientError(
      typeof data["code"] === "string" ? data["code"] : null,
      typeof data["message"] === "string" ? data["message"] : "The attachment request was refused.",
    );
  }
  return new IssueAttachmentClientError(
    null,
    typeof navigator !== "undefined" && navigator.onLine === false
      ? "Attachments need an internet connection on cloud-synced issues."
      : error instanceof Error
        ? error.message
        : "The attachment request failed.",
  );
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface IssueAttachmentClient {
  readonly upload: (input: {
    readonly companyId: CompanyId;
    readonly issueId: IssueId;
    readonly clientRequestId: string;
    readonly fileName: string;
    readonly file: File;
  }) => Promise<ChatAttachmentId>;
  readonly urls: (input: {
    readonly companyId: CompanyId;
    readonly issueId: IssueId;
    readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
  }) => Promise<ReadonlyArray<ReplicaIssueAttachment>>;
  readonly close: () => Promise<void>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function makeIssueAttachmentClient(options: {
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
  readonly client?: IssueAttachmentConvexClient;
  readonly fetcher?: FetchLike;
}): IssueAttachmentClient {
  const ownsClient = options.client === undefined;
  const client = options.client ?? new ConvexClient(options.convexUrl);
  const fetcher = options.fetcher ?? fetch;
  client.setAuth(options.fetchToken);
  const call = async <A>(run: () => Promise<unknown>): Promise<A> => {
    try {
      return (await run()) as A;
    } catch (error) {
      throw mapIssueAttachmentClientError(error);
    }
  };

  return {
    upload: async (input) => {
      const checksum = await sha256Hex(input.file);
      const [prepared] = await call<ReadonlyArray<PrepareResult>>(() =>
        client.action(ISSUE_ATTACHMENT_FUNCTION_REFERENCES.prepareUpload, {
          companyId: input.companyId,
          issueId: input.issueId,
          uploads: [
            {
              clientRequestId: input.clientRequestId,
              fileName: input.fileName,
              mimeType: input.file.type,
              byteSize: input.file.size,
              checksum,
            },
          ],
        }),
      );
      if (prepared === undefined)
        throw new IssueAttachmentClientError(null, "No attachment upload was prepared.");
      if (prepared.state === "upload-required") {
        if (prepared.uploadUrl === null)
          throw new IssueAttachmentClientError(null, "No attachment upload URL was returned.");
        const body = new FormData();
        body.append("file", input.file, input.fileName);
        const response = await fetcher(prepared.uploadUrl, { method: "PUT", body });
        if (!response.ok)
          throw new IssueAttachmentClientError(
            "upload-failed",
            `UploadThing rejected the file with HTTP ${response.status}.`,
          );
        await call(() =>
          client.action(ISSUE_ATTACHMENT_FUNCTION_REFERENCES.finalizeUpload, {
            companyId: input.companyId,
            attachmentId: prepared.attachmentId,
          }),
        );
      }
      return prepared.attachmentId;
    },
    urls: (input) => call(() => client.query(ISSUE_ATTACHMENT_FUNCTION_REFERENCES.urls, input)),
    close: () => (ownsClient ? client.close() : Promise.resolve()),
  };
}

export interface ReplicaIssueAttachmentCloud {
  readonly companyId: CompanyId;
  readonly client: IssueAttachmentClient;
  readonly isOnline: boolean;
}

/** One short-lived Convex client per open issue sheet; legacy sheets create none. */
export function useReplicaIssueAttachmentCloud(
  companyId: CompanyId | null,
): ReplicaIssueAttachmentCloud | null {
  const { getToken } = useAuth();
  const convexUrl = resolveCloudSyncConvexUrl();
  const [isOnline, setIsOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const client = useMemo(
    () =>
      companyId === null || convexUrl === null
        ? null
        : makeIssueAttachmentClient({
            convexUrl,
            fetchToken: makeClerkConvexTokenFetcher(getToken),
          }),
    [companyId, convexUrl, getToken],
  );

  useEffect(() => () => void client?.close(), [client]);
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return useMemo(
    () => (companyId === null || client === null ? null : { companyId, client, isOnline }),
    [client, companyId, isOnline],
  );
}
