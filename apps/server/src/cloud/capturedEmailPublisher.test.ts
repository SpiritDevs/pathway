import { EmailMessageId, type CapturedEmailMessage } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { capturedEmailPublicationIdentity } from "./capturedEmailPublisher.ts";

const message = (isRead: boolean): CapturedEmailMessage =>
  ({
    id: EmailMessageId.make("email-one"),
    attribution: { projectId: null },
    timings: { storedAt: "2026-08-17T00:00:00.000Z" },
    isRead,
  }) as CapturedEmailMessage;

describe("captured email publisher", () => {
  it("re-publishes when read state changes without hashing immutable message bodies", () => {
    expect(capturedEmailPublicationIdentity(message(false))).not.toBe(
      capturedEmailPublicationIdentity(message(true)),
    );
  });
});
