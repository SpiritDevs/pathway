import type { ChatAttachmentId, IssueId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  makeIssueAttachmentClient,
  type IssueAttachmentConvexClient,
} from "./issueAttachmentClient";

const COMPANY_ID = "company-1" as CompanyId;
const ISSUE_ID = "issue-1" as IssueId;
const ATTACHMENT_ID = "attachment-1" as ChatAttachmentId;

describe("replica issue attachment client", () => {
  it("prepares, uploads, and finalizes before returning the stable attachment id", async () => {
    const calls: Array<{ readonly kind: string; readonly name: string; readonly args: unknown }> =
      [];
    const convex: IssueAttachmentConvexClient = {
      action: async (reference, args) => {
        const name = getFunctionName(reference);
        calls.push({ kind: "action", name, args });
        return name === "issueAttachments:prepareUpload"
          ? [
              {
                attachmentId: ATTACHMENT_ID,
                state: "upload-required",
                uploadUrl: "https://upload.test",
              },
            ]
          : { status: "ready" };
      },
      query: async (reference, args) => {
        calls.push({ kind: "query", name: getFunctionName(reference), args });
        return [];
      },
      setAuth: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    const client = makeIssueAttachmentClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "token",
      client: convex,
      fetcher,
    });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", {
      type: "image/png",
    });

    await expect(
      client.upload({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        clientRequestId: "request-1",
        fileName: "shot.png",
        file,
      }),
    ).resolves.toBe(ATTACHMENT_ID);

    expect(calls.map((call) => call.name)).toEqual([
      "issueAttachments:prepareUpload",
      "issueAttachments:finalizeUpload",
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    expect(calls[0]?.args).toMatchObject({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      uploads: [
        {
          clientRequestId: "request-1",
          fileName: "shot.png",
          mimeType: "image/png",
          byteSize: 4,
        },
      ],
    });
  });

  it("does not PUT or finalize an id that an idempotent prepare says is already ready", async () => {
    const action = vi.fn(async () => [
      { attachmentId: ATTACHMENT_ID, state: "ready", uploadUrl: null },
    ]);
    const convex: IssueAttachmentConvexClient = {
      action,
      query: vi.fn(async () => []),
      setAuth: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    const client = makeIssueAttachmentClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "token",
      client: convex,
      fetcher,
    });

    await expect(
      client.upload({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        clientRequestId: "request-1",
        fileName: "shot.png",
        file: new File([new Uint8Array([1])], "shot.png", { type: "image/png" }),
      }),
    ).resolves.toBe(ATTACHMENT_ID);
    expect(action).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves display metadata through the permission-checked Convex query", async () => {
    let queryName: string | null = null;
    let queryArgs: unknown = null;
    const convex: IssueAttachmentConvexClient = {
      action: vi.fn(async () => []),
      query: async (reference, args) => {
        queryName = getFunctionName(reference);
        queryArgs = args;
        return [
          {
            attachmentId: ATTACHMENT_ID,
            fileName: "evidence.webm",
            mimeType: "video/webm",
            byteSize: 123,
            url: "https://utfs.io/f/file-key",
          },
        ];
      },
      setAuth: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const client = makeIssueAttachmentClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "token",
      client: convex,
    });

    await expect(
      client.urls({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        attachmentIds: [ATTACHMENT_ID],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        attachmentId: ATTACHMENT_ID,
        mimeType: "video/webm",
        url: "https://utfs.io/f/file-key",
      }),
    ]);
    expect(queryName).toBe("issueAttachments:urls");
    expect(queryArgs).toEqual({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      attachmentIds: [ATTACHMENT_ID],
    });
  });
});
