import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CapturedEmailMessage,
  DEFAULT_EMAIL_CAPTURE_SETTINGS,
  EMAIL_WS_METHODS,
  EmailCaptureSettings,
  EmailListInput,
  EmailMailSlug,
  EmailStreamEvent,
  EmailTriggerRule,
  EmailWaitRegistration,
} from "./email.ts";

const decodeCapturedEmailMessage = Schema.decodeUnknownSync(CapturedEmailMessage);
const decodeEmailMailSlug = Schema.decodeUnknownSync(EmailMailSlug);
const decodeEmailCaptureSettings = Schema.decodeUnknownSync(EmailCaptureSettings);
const decodeEmailTriggerRule = Schema.decodeUnknownSync(EmailTriggerRule);
const decodeEmailWaitRegistration = Schema.decodeUnknownSync(EmailWaitRegistration);
const decodeEmailListInput = Schema.decodeUnknownSync(EmailListInput);
const decodeEmailStreamEvent = Schema.decodeUnknownSync(EmailStreamEvent);

const MESSAGE_JSON = {
  id: "message-1",
  attribution: {
    projectId: "project-1",
    mailSlug: "my-app",
    matchedBy: "recipient-domain",
    matchedValue: "hello@my-app.test",
  },
  envelope: {
    mailFrom: "sender@example.com",
    rcptTo: ["hello@my-app.test"],
    authUsername: null,
    helo: "localhost",
    remoteAddress: "127.0.0.1",
  },
  parsedHeaders: {
    subject: "Your verification code",
    messageId: "message@example.com",
    date: "2026-08-12T10:00:00.000Z",
    from: [{ address: "sender@example.com", name: "Sender" }],
    to: [{ address: "hello@my-app.test", name: null }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: [
      { name: "From", value: "Sender <sender@example.com>" },
      { name: "Subject", value: "Your verification code" },
    ],
  },
  textBody: "Use 482913 to sign in.",
  htmlBody: "<p>Use <strong>482913</strong> to sign in.</p>",
  attachments: [
    {
      id: "attachment-1",
      filename: "receipt.pdf",
      contentType: "application/pdf",
      contentDisposition: "attachment",
      contentId: null,
      sizeBytes: 2048,
    },
  ],
  smtpTransactionLog: [
    { at: "2026-08-12T10:00:00.000Z", direction: "server", line: "220 Pathway SMTP" },
    {
      at: "2026-08-12T10:00:00.010Z",
      direction: "client",
      line: "  MAIL FROM:<sender@example.com>  ",
    },
  ],
  timings: {
    connectedAt: "2026-08-12T10:00:00.000Z",
    messageReceivedAt: "2026-08-12T10:00:00.100Z",
    parsedAt: "2026-08-12T10:00:00.120Z",
    storedAt: "2026-08-12T10:00:00.125Z",
    parseDurationMs: 20,
    totalDurationMs: 125,
  },
  sizeBytes: 4096,
  isRead: false,
  detectedCode: "482913",
};

describe("CapturedEmailMessage", () => {
  it("round-trips the complete capture through the RPC JSON codec", () => {
    const codec = Schema.toCodecJson(CapturedEmailMessage);
    const decode = Schema.decodeUnknownSync(codec);
    const encode = Schema.encodeUnknownSync(codec);
    const message = decode(MESSAGE_JSON);

    expect(decode(encode(message))).toStrictEqual(message);
    expect(message.smtpTransactionLog[1]?.line).toBe("  MAIL FROM:<sender@example.com>  ");
  });

  it("rejects an illegal mail slug and an out-of-range detected code", () => {
    expect(() => decodeEmailMailSlug("My_App")).toThrow();
    expect(() => decodeCapturedEmailMessage({ ...MESSAGE_JSON, detectedCode: "123" })).toThrow();
  });

  it.each(["auth-username", "recipient-domain", "recipient-plus-tag", "unassigned"] as const)(
    "retains the %s routing decision",
    (matchedBy) => {
      const unassigned = matchedBy === "unassigned";
      const message = decodeCapturedEmailMessage({
        ...MESSAGE_JSON,
        attribution: {
          projectId: unassigned ? null : "project-1",
          mailSlug: unassigned ? null : "my-app",
          matchedBy,
          matchedValue: unassigned ? null : "my-app",
        },
      });

      expect(message.attribution.matchedBy).toBe(matchedBy);
    },
  );
});

describe("EmailCaptureSettings", () => {
  it("hydrates the agreed listener and retention defaults", () => {
    expect(DEFAULT_EMAIL_CAPTURE_SETTINGS).toEqual({
      listener: { enabled: true, bindAddress: "0.0.0.0", port: 1025 },
      retention: { maxMessages: 500, maxAgeDays: 7 },
      toastsEnabled: true,
      projects: [],
    });
    expect(decodeEmailCaptureSettings({})).toEqual(DEFAULT_EMAIL_CAPTURE_SETTINGS);
  });

  it("hydrates per-project overrides without making configuration mandatory", () => {
    expect(
      decodeEmailCaptureSettings({
        projects: [{ projectId: "project-1", mailSlug: "my-app" }],
      }).projects[0],
    ).toEqual({
      projectId: "project-1",
      mailSlug: "my-app",
      retention: { maxMessages: null, maxAgeDays: null },
      toastMuted: false,
      twoFactorCodeRegex: null,
      triggerRules: [],
    });
  });

  it.each([0, 65_536, 1025.5])("rejects an invalid listener port: %s", (port) => {
    expect(() => decodeEmailCaptureSettings({ listener: { port } })).toThrow();
  });

  it("requires positive retention and trigger rate limits", () => {
    expect(() => decodeEmailCaptureSettings({ retention: { maxMessages: 0 } })).toThrow();
    expect(() =>
      decodeEmailTriggerRule({
        id: "rule-1",
        name: "Login mail",
        enabled: true,
        matcher: { sender: null, subject: "code", recipient: null },
        promptTemplate: "Handle message {{messageId}}",
        maxTriggersPerHour: 0,
        rateLimitWindowStartedAt: null,
        triggersInCurrentWindow: 0,
        autoDisabledAt: null,
        autoDisabledReason: null,
      }),
    ).toThrow();
  });
});

describe("Email waits and WebSocket payloads", () => {
  it("round-trips a durable task wait", () => {
    const wait = decodeEmailWaitRegistration({
      id: "wait-1",
      threadId: "thread-1",
      providerInstanceId: "codex",
      criteria: {
        scope: { type: "project", projectId: "project-1" },
        sender: "accounts@example.com",
        subject: "verification",
        recipient: null,
      },
      delivery: "task",
      taskId: "task-1",
      status: "pending",
      registeredAt: "2026-08-12T10:00:00.000Z",
      expiresAt: "2026-08-12T10:02:00.000Z",
      completedAt: null,
      matchedMessageId: null,
    });

    expect(wait.taskId).toBe("task-1");
    expect(wait.criteria.scope).toEqual({ type: "project", projectId: "project-1" });
  });

  it("decodes list filters and exposes every requested WS method", () => {
    expect(
      decodeEmailListInput({
        scope: { type: "unassigned" },
        limit: 50,
        filters: { isRead: false, subject: "verification" },
      }),
    ).toEqual({
      scope: { type: "unassigned" },
      limit: 50,
      filters: { isRead: false, subject: "verification" },
    });
    expect(Object.values(EMAIL_WS_METHODS)).toEqual([
      "email.list",
      "email.get",
      "email.markRead",
      "email.markUnread",
      "email.clearInbox",
      "email.getSettings",
      "email.updateSettings",
      "email.stream",
    ]);
  });

  it("carries a detected code on the live captured event", () => {
    const event = decodeEmailStreamEvent({
      _tag: "EmailCaptured",
      message: {
        id: "message-1",
        attribution: MESSAGE_JSON.attribution,
        from: MESSAGE_JSON.parsedHeaders.from,
        to: MESSAGE_JSON.parsedHeaders.to,
        subject: MESSAGE_JSON.parsedHeaders.subject,
        textPreview: "Use 482913 to sign in.",
        receivedAt: MESSAGE_JSON.timings.messageReceivedAt,
        sizeBytes: MESSAGE_JSON.sizeBytes,
        attachmentCount: 1,
        isRead: false,
        detectedCode: "482913",
      },
      detectedCode: "482913",
      inboxes: [],
    });

    expect(event._tag).toBe("EmailCaptured");
    if (event._tag === "EmailCaptured") {
      expect(event.detectedCode).toBe("482913");
    }
  });
});
