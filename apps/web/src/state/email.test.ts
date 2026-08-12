import type {
  CapturedEmailSummary,
  EmailInboxSummary,
  EmailMessageId,
  EmailSettingsSnapshot,
  EmailStreamEvent,
  ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_EMAIL_CAPTURE_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_EMAIL_SCOPE,
  applyEmailStreamEvent,
  applyEmailStreamEvents,
  emailScopeKey,
  emailScopesEqual,
  EMPTY_EMAIL_STREAM_STATE,
  findEmailInbox,
  totalEmailUnreadCount,
  UNASSIGNED_EMAIL_SCOPE,
} from "./email";

const PROJECT_ID = "prj_1" as ProjectId;

function inbox(unreadCount: number, overrides?: Partial<EmailInboxSummary>): EmailInboxSummary {
  return {
    scope: ALL_EMAIL_SCOPE,
    name: "All mail",
    mailSlug: null,
    messageCount: 10,
    unreadCount,
    toastMuted: false,
    ...overrides,
  };
}

function summary(id: string): CapturedEmailSummary {
  return {
    id: id as EmailMessageId,
    attribution: {
      projectId: null,
      mailSlug: null,
      matchedBy: "unassigned",
      matchedValue: null,
    },
    from: [{ address: "noreply@example.com", name: null }],
    to: [{ address: "dev@example.test", name: null }],
    subject: "Verify your email",
    textPreview: "Your code is 123456",
    receivedAt: "2026-08-12T10:00:00.000Z",
    sizeBytes: 2048,
    attachmentCount: 0,
    isRead: false,
    detectedCode: "123456",
  };
}

const SETTINGS_SNAPSHOT: EmailSettingsSnapshot = {
  settings: DEFAULT_EMAIL_CAPTURE_SETTINGS,
  listenerStatus: { state: "listening", bindAddress: "0.0.0.0", port: 1025, error: null },
};

describe("emailScopeKey", () => {
  it("is total across every scope shape", () => {
    expect(emailScopeKey(ALL_EMAIL_SCOPE)).toBe("all");
    expect(emailScopeKey(UNASSIGNED_EMAIL_SCOPE)).toBe("unassigned");
    expect(emailScopeKey({ type: "project", projectId: PROJECT_ID })).toBe("project:prj_1");
  });

  it("compares scopes by content rather than identity", () => {
    expect(emailScopesEqual({ type: "all" }, { type: "all" })).toBe(true);
    expect(
      emailScopesEqual(
        { type: "project", projectId: PROJECT_ID },
        { type: "project", projectId: "prj_2" as ProjectId },
      ),
    ).toBe(false);
  });
});

describe("applyEmailStreamEvent", () => {
  it("bumps the revision and takes the inboxes a capture carries", () => {
    const event: EmailStreamEvent = {
      _tag: "EmailCaptured",
      message: summary("msg_1"),
      detectedCode: "123456",
      inboxes: [inbox(3)],
    };

    const next = applyEmailStreamEvent(EMPTY_EMAIL_STREAM_STATE, event);

    expect(next.revision).toBe(1);
    expect(next.lastCaptured?.id).toBe("msg_1");
    expect(totalEmailUnreadCount(next.inboxes ?? [])).toBe(3);
  });

  it("invalidates on a read-state change without claiming a new capture", () => {
    const captured = applyEmailStreamEvent(EMPTY_EMAIL_STREAM_STATE, {
      _tag: "EmailCaptured",
      message: summary("msg_1"),
      detectedCode: null,
      inboxes: [inbox(3)],
    });

    const next = applyEmailStreamEvent(captured, {
      _tag: "EmailReadStateChanged",
      messageIds: ["msg_1" as EmailMessageId],
      isRead: true,
      inboxes: [inbox(2)],
    });

    expect(next.revision).toBe(2);
    expect(next.lastCaptured?.id).toBe("msg_1");
    expect(totalEmailUnreadCount(next.inboxes ?? [])).toBe(2);
  });

  it("invalidates on a clear, so the emptied list is refetched", () => {
    const next = applyEmailStreamEvent(EMPTY_EMAIL_STREAM_STATE, {
      _tag: "EmailInboxCleared",
      scope: ALL_EMAIL_SCOPE,
      clearedCount: 4,
      inboxes: [inbox(0, { messageCount: 0 })],
    });

    expect(next.revision).toBe(1);
    expect(findEmailInbox(next.inboxes ?? [], ALL_EMAIL_SCOPE)?.messageCount).toBe(0);
  });

  it("leaves the state untouched for a settings change, which moves no message", () => {
    const next = applyEmailStreamEvent(EMPTY_EMAIL_STREAM_STATE, {
      _tag: "EmailSettingsChanged",
      snapshot: SETTINGS_SNAPSHOT,
    });

    expect(next).toBe(EMPTY_EMAIL_STREAM_STATE);
  });
});

describe("applyEmailStreamEvents", () => {
  it("folds a chunk into one revision step per event", () => {
    const next = applyEmailStreamEvents(EMPTY_EMAIL_STREAM_STATE, [
      { _tag: "EmailCaptured", message: summary("msg_1"), detectedCode: null, inboxes: [inbox(1)] },
      { _tag: "EmailCaptured", message: summary("msg_2"), detectedCode: null, inboxes: [inbox(2)] },
      { _tag: "EmailSettingsChanged", snapshot: SETTINGS_SNAPSHOT },
    ]);

    expect(next.revision).toBe(2);
    expect(next.lastCaptured?.id).toBe("msg_2");
  });

  it("returns the same state for a chunk that moved nothing", () => {
    const next = applyEmailStreamEvents(EMPTY_EMAIL_STREAM_STATE, [
      { _tag: "EmailSettingsChanged", snapshot: SETTINGS_SNAPSHOT },
    ]);

    expect(next).toBe(EMPTY_EMAIL_STREAM_STATE);
  });
});

describe("findEmailInbox", () => {
  it("finds by content so a rebuilt scope object still matches", () => {
    const inboxes = [
      inbox(3),
      inbox(1, { scope: { type: "project", projectId: PROJECT_ID }, name: "Pathway" }),
    ];

    expect(findEmailInbox(inboxes, { type: "project", projectId: PROJECT_ID })?.name).toBe(
      "Pathway",
    );
    expect(findEmailInbox(inboxes, UNASSIGNED_EMAIL_SCOPE)).toBeNull();
    expect(totalEmailUnreadCount(inboxes)).toBe(3);
  });
});
