import type {
  EmailMessageId,
  EmailTagId,
  EnvironmentId,
  TrustedEmailSenderId,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  makeCapturedEmailAdminClient,
  type CapturedEmailAdminConvexClient,
} from "./capturedEmailAdmin";

const COMPANY_A = "company-a" as CompanyId;
const COMPANY_B = "company-b" as CompanyId;
const ENVIRONMENT_ID = "environment-1" as EnvironmentId;
const MESSAGE_ID = "message-1" as EmailMessageId;
const TAG_ID = "tag-1" as EmailTagId;
const SENDER_ID = "sender-1" as TrustedEmailSenderId;

describe("captured email admin client", () => {
  it("routes each write through the company supplied by its owning row", async () => {
    const calls: Array<{ readonly name: string; readonly args: unknown }> = [];
    const convex: CapturedEmailAdminConvexClient = {
      mutation: async (reference, args) => {
        calls.push({ name: getFunctionName(reference), args });
        return null;
      },
      setAuth: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const admin = makeCapturedEmailAdminClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "token",
      client: convex,
    });

    await admin.setTag(
      COMPANY_A,
      { environmentId: ENVIRONMENT_ID, messageId: MESSAGE_ID },
      TAG_ID,
      true,
    );
    await admin.deleteMessages(COMPANY_B, [
      { environmentId: ENVIRONMENT_ID, messageId: MESSAGE_ID },
    ]);
    await admin.trustSender(COMPANY_A, "sender@example.com");
    await admin.removeTrustedSender(COMPANY_B, SENDER_ID);

    expect(calls).toEqual([
      {
        name: "capturedEmails:setTag",
        args: {
          companyId: COMPANY_A,
          environmentId: ENVIRONMENT_ID,
          messageId: MESSAGE_ID,
          tagId: TAG_ID,
          present: true,
        },
      },
      {
        name: "capturedEmails:remove",
        args: {
          companyId: COMPANY_B,
          messages: [{ environmentId: ENVIRONMENT_ID, messageId: MESSAGE_ID }],
        },
      },
      {
        name: "trustedEmailSenders:trust",
        args: expect.objectContaining({ companyId: COMPANY_A, address: "sender@example.com" }),
      },
      {
        name: "trustedEmailSenders:remove",
        args: { companyId: COMPANY_B, trustedSenderId: SENDER_ID },
      },
    ]);
  });
});
