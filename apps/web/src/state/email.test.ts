import type {
  CapturedEmailSummary,
  CapturedEmailMessage,
  EmailInboxSummary,
  EmailMessageId,
  EmailSettingsSnapshot,
  EmailTagId,
  EmailStreamEvent,
  EmailTriggerFiringId,
  EmailTriggerRuleId,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@spiritdevs/contracts";
import { DEFAULT_EMAIL_CAPTURE_SETTINGS } from "@spiritdevs/contracts";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_EMAIL_SCOPE,
  applyEmailStreamEvent,
  applyEmailStreamEvents,
  emailScopeKey,
  emailScopesEqual,
  emailInboxSummariesFromMessages,
  emailListInputForProjectConnections,
  EMPTY_EMAIL_STREAM_STATE,
  findEmailInbox,
  mergeSyncedInboxSummaries,
  mergeSyncedMessages,
  totalEmailUnreadCount,
  UNASSIGNED_EMAIL_SCOPE,
} from "./email";

const PROJECT_ID = "prj_1" as ProjectId;
const REMOTE_PROJECT_ID = "remote_prj_1" as ProjectId;
const PRIMARY_ENVIRONMENT_ID = "environment-primary" as EnvironmentId;
const REMOTE_ENVIRONMENT_ID = "environment-remote" as EnvironmentId;
const CLOUD_PROJECT_ID = "cloud-project-1" as CloudProjectId;
const COMPANY_ID = "company-1" as CompanyId;
const OTHER_COMPANY_ID = "company-2" as CompanyId;

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

function message(id: string, projectId: ProjectId, subject: string): CapturedEmailMessage {
  return {
    ...summary(id),
    attribution: {
      projectId,
      mailSlug: "pathway" as CapturedEmailMessage["attribution"]["mailSlug"],
      matchedBy: "auth-username",
      matchedValue: "pathway",
    },
    envelope: {
      mailFrom: "noreply@example.com",
      rcptTo: ["dev@example.test"],
      authUsername: "pathway",
      helo: null,
      remoteAddress: null,
    },
    parsedHeaders: {
      subject,
      messageId: null,
      date: null,
      from: [{ address: "noreply@example.com", name: null }],
      to: [{ address: "dev@example.test", name: null }],
      cc: [],
      bcc: [],
      replyTo: [],
      headers: [],
    },
    textBody: "Your code is 123456",
    htmlBody: null,
    attachments: [],
    smtpTransactionLog: [],
    timings: {
      connectedAt: "2026-08-12T10:00:00.000Z",
      messageReceivedAt: "2026-08-12T10:00:00.000Z",
      parsedAt: "2026-08-12T10:00:00.000Z",
      storedAt: "2026-08-12T10:00:00.000Z",
      parseDurationMs: 0,
      totalDurationMs: 0,
    },
    deliverability: {
      version: 1,
      checks: [],
      metrics: {
        subjectLength: subject.length,
        imageCount: 0,
        visibleTextCharacters: 19,
        imageToTextRatio: 0,
        trackingPixelCount: 0,
      },
      htmlCompatibilityWarnings: [],
    },
  };
}

const SETTINGS_SNAPSHOT: EmailSettingsSnapshot = {
  settings: DEFAULT_EMAIL_CAPTURE_SETTINGS,
  listenerStatus: { state: "listening", bindAddress: "0.0.0.0", port: 1025, error: null },
};

const AUTO_DISABLED_EVENT = {
  _tag: "EmailTriggerRuleAutoDisabled",
  rule: {
    id: "rule_1" as EmailTriggerRuleId,
    name: "Password resets",
    enabled: false,
    matcher: { sender: "noreply@example.com", subject: null, recipient: null },
    promptTemplate: "Investigate {{subject}}",
    maxTriggersPerHour: 5,
    rateLimitWindowStartedAt: null,
    triggersInCurrentWindow: 1,
    autoDisabledAt: "2026-08-12T10:05:00.000Z",
    autoDisabledReason: "This rule matched a message its own run produced.",
  },
  firing: {
    id: "firing_1" as EmailTriggerFiringId,
    ruleId: "rule_1" as EmailTriggerRuleId,
    projectId: PROJECT_ID,
    messageId: "msg_1" as EmailMessageId,
    threadId: "thr_1" as ThreadId,
    firedAt: "2026-08-12T10:04:00.000Z",
    status: "loop-detected",
    error: null,
    loopMessageId: "msg_2" as EmailMessageId,
  },
  loopMessageId: "msg_2" as EmailMessageId,
  notice: "Password resets was disabled after its own run produced a matching message.",
} as const satisfies EmailStreamEvent;

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

describe("emailListInputForProjectConnections", () => {
  it("asks the primary server for every local connection in a logical project", () => {
    expect(
      emailListInputForProjectConnections(
        { type: "project", projectId: PROJECT_ID },
        PRIMARY_ENVIRONMENT_ID,
        [
          { environmentId: PRIMARY_ENVIRONMENT_ID, id: PROJECT_ID },
          { environmentId: PRIMARY_ENVIRONMENT_ID, id: "prj_2" as ProjectId },
          { environmentId: REMOTE_ENVIRONMENT_ID, id: REMOTE_PROJECT_ID },
        ],
      ),
    ).toEqual({
      scope: { type: "project", projectId: PROJECT_ID },
      projectIds: [PROJECT_ID, "prj_2"],
    });
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

  it("invalidates when specific messages are deleted", () => {
    const next = applyEmailStreamEvent(EMPTY_EMAIL_STREAM_STATE, {
      _tag: "EmailMessagesDeleted",
      messageIds: ["msg_1" as EmailMessageId],
      inboxes: [inbox(0, { messageCount: 0 })],
    });

    expect(next.revision).toBe(1);
    expect(findEmailInbox(next.inboxes ?? [], ALL_EMAIL_SCOPE)?.messageCount).toBe(0);
  });

  it("adopts pushed settings without invalidating the message list", () => {
    const next = applyEmailStreamEvent(EMPTY_EMAIL_STREAM_STATE, {
      _tag: "EmailSettingsChanged",
      snapshot: SETTINGS_SNAPSHOT,
    });

    expect(next.revision).toBe(0);
    expect(next.settings).toBe(SETTINGS_SNAPSHOT);
  });

  it("keeps the loop-detection notice so it can be raised from any route", () => {
    const next = applyEmailStreamEvent(EMPTY_EMAIL_STREAM_STATE, AUTO_DISABLED_EVENT);

    expect(next.revision).toBe(0);
    expect(next.lastAutoDisabledTrigger?.rule.id).toBe("rule_1");
    expect(next.lastAutoDisabledTrigger?.notice).toBe(AUTO_DISABLED_EVENT.notice);
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

  it("leaves the revision alone for a chunk that moved no message", () => {
    const next = applyEmailStreamEvents(EMPTY_EMAIL_STREAM_STATE, [
      { _tag: "EmailSettingsChanged", snapshot: SETTINGS_SNAPSHOT },
      AUTO_DISABLED_EVENT,
    ]);

    expect(next.revision).toBe(0);
    expect(next.lastCaptured).toBeNull();
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

describe("cross-environment captured mail", () => {
  const bindings = new Map([
    [
      `${PRIMARY_ENVIRONMENT_ID}\0${PROJECT_ID}`,
      [{ companyId: COMPANY_ID, cloudProjectId: CLOUD_PROJECT_ID }],
    ] as const,
  ]);
  const synced = [
    {
      companyId: COMPANY_ID,
      environmentId: PRIMARY_ENVIRONMENT_ID,
      cloudProjectId: CLOUD_PROJECT_ID,
      message: message("local-one", PROJECT_ID, "Stale replica copy"),
      tagIds: ["tag-auth" as EmailTagId],
    },
    {
      companyId: COMPANY_ID,
      environmentId: REMOTE_ENVIRONMENT_ID,
      cloudProjectId: CLOUD_PROJECT_ID,
      message: message("remote-one", REMOTE_PROJECT_ID, "Remote capture"),
      tagIds: [],
    },
  ];

  it("groups different local project ids through the shared cloud project and keeps local fresh", () => {
    const local = [
      {
        ...summary("local-one"),
        subject: "Fresh local copy",
        attribution: {
          projectId: PROJECT_ID,
          mailSlug: null,
          matchedBy: "auth-username" as const,
          matchedValue: "pathway",
        },
      },
    ];
    const rows = mergeSyncedMessages({
      local,
      synced,
      primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      scope: { type: "project", projectId: PROJECT_ID },
      environmentId: null,
      bindings,
      selectedCompanyId: null,
    });

    expect(rows.map((row) => [row.environmentId, row.subject])).toEqual([
      [PRIMARY_ENVIRONMENT_ID, "Fresh local copy"],
      [REMOTE_ENVIRONMENT_ID, "Remote capture"],
    ]);
    expect(rows[0]?.tagIds).toEqual(["tag-auth"]);
    expect(rows.map((row) => row.companyId)).toEqual([COMPANY_ID, COMPANY_ID]);
  });

  it("groups every explicit project connection without requiring a cloud binding", () => {
    const rows = mergeSyncedMessages({
      local: [],
      synced,
      primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      scope: { type: "project", projectId: PROJECT_ID },
      environmentId: null,
      bindings: new Map(),
      selectedCompanyId: null,
      projectConnections: [
        { environmentId: PRIMARY_ENVIRONMENT_ID, id: PROJECT_ID },
        { environmentId: REMOTE_ENVIRONMENT_ID, id: REMOTE_PROJECT_ID },
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["local-one", "remote-one"]);
    const summaries = emailInboxSummariesFromMessages({
      messages: rows,
      local: [],
    });
    expect(findEmailInbox(summaries, { type: "project", projectId: PROJECT_ID })).toMatchObject({
      messageCount: 1,
      unreadCount: 1,
    });
    expect(
      findEmailInbox(summaries, { type: "project", projectId: REMOTE_PROJECT_ID }),
    ).toMatchObject({
      messageCount: 1,
      unreadCount: 1,
    });

    expect(
      mergeSyncedMessages({
        local: [],
        synced,
        primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
        scope: UNASSIGNED_EMAIL_SCOPE,
        environmentId: null,
        bindings: new Map(),
        selectedCompanyId: null,
      }),
    ).toEqual([]);
  });

  it("does not leak a local row whose company cannot be proven into a company selection", () => {
    const rows = mergeSyncedMessages({
      local: [summary("not-yet-synced")],
      synced,
      primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      scope: ALL_EMAIL_SCOPE,
      environmentId: null,
      bindings,
      selectedCompanyId: OTHER_COMPANY_ID,
    });

    expect(rows).toEqual([]);
  });

  it("keeps duplicate source identities separate and refuses an ambiguous local overlay", () => {
    const rows = mergeSyncedMessages({
      local: [
        {
          ...summary("local-one"),
          subject: "Ambiguous fresh copy",
          attribution: {
            projectId: PROJECT_ID,
            mailSlug: null,
            matchedBy: "auth-username" as const,
            matchedValue: "pathway",
          },
        },
      ],
      synced: [
        synced[0]!,
        {
          ...synced[0]!,
          companyId: OTHER_COMPANY_ID,
          message: message("local-one", PROJECT_ID, "Other company copy"),
        },
      ],
      primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      scope: ALL_EMAIL_SCOPE,
      environmentId: null,
      bindings,
      selectedCompanyId: null,
    });

    expect(rows.map((row) => [row.companyId, row.subject])).toEqual([
      [COMPANY_ID, "Stale replica copy"],
      [OTHER_COMPANY_ID, "Other company copy"],
    ]);
    const summaries = emailInboxSummariesFromMessages({
      messages: rows,
      local: [inbox(99, { messageCount: 99 })],
    });
    expect(findEmailInbox(summaries, ALL_EMAIL_SCOPE)).toMatchObject({
      messageCount: 2,
      unreadCount: 2,
    });
    expect(findEmailInbox(summaries, { type: "project", projectId: PROJECT_ID })).toMatchObject({
      messageCount: 2,
      unreadCount: 2,
    });
  });

  it("filters rows by source environment and adds only remote copies to local inbox counts", () => {
    const rows = mergeSyncedMessages({
      local: [],
      synced,
      primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      scope: { type: "project", projectId: PROJECT_ID },
      environmentId: REMOTE_ENVIRONMENT_ID,
      bindings,
      selectedCompanyId: null,
    });
    expect(rows.map((row) => row.id)).toEqual(["remote-one"]);

    const summaries = mergeSyncedInboxSummaries({
      local: [inbox(1, { messageCount: 1 })],
      synced,
      primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      bindings,
      selectedCompanyId: null,
    });
    expect(findEmailInbox(summaries, ALL_EMAIL_SCOPE)).toMatchObject({
      messageCount: 2,
      unreadCount: 2,
    });
    expect(findEmailInbox(summaries, { type: "project", projectId: PROJECT_ID })).toMatchObject({
      messageCount: 1,
      unreadCount: 1,
    });

    const companySummaries = mergeSyncedInboxSummaries({
      local: [inbox(99, { messageCount: 99 })],
      synced,
      primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      bindings,
      selectedCompanyId: COMPANY_ID,
    });
    expect(findEmailInbox(companySummaries, ALL_EMAIL_SCOPE)).toMatchObject({
      messageCount: 2,
      unreadCount: 2,
    });
  });
});
