import type {
  CapturedEmailSummary,
  EmailCaptureSettings,
  EmailListenerStatus,
  EmailMailSlug,
  EmailMessageId,
  EmailTriggerRule,
  EmailTriggerRuleId,
  ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_EMAIL_CAPTURE_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  emailCaptureAddress,
  emailSenderLabel,
  emailTriggerRuleState,
  emailTriggerRuleToDraft,
  EMPTY_EMAIL_TRIGGER_RULE_DRAFT,
  findEmailProjectSettings,
  isEmailPortConflict,
  isEmailProjectMuted,
  mailSlugError,
  otherMailSlugs,
  parseOptionalPositiveInteger,
  parsePort,
  parsePositiveInteger,
  shouldToastCapturedEmail,
  summarizeEmailListener,
  validateEmailTriggerRuleDraft,
  describeEmailTriggerMatcher,
  withEmailProjectSettings,
} from "./emailSettings.logic";

const PROJECT_ID = "prj_1" as ProjectId;
const OTHER_PROJECT_ID = "prj_2" as ProjectId;

function settings(overrides?: Partial<EmailCaptureSettings>): EmailCaptureSettings {
  return {
    ...DEFAULT_EMAIL_CAPTURE_SETTINGS,
    projects: [
      {
        projectId: PROJECT_ID,
        mailSlug: "pathway" as EmailMailSlug,
        retention: { maxMessages: null, maxAgeDays: null },
        toastMuted: false,
        twoFactorCodeRegex: null,
      },
      {
        projectId: OTHER_PROJECT_ID,
        mailSlug: "storefront" as EmailMailSlug,
        retention: { maxMessages: 50, maxAgeDays: null },
        toastMuted: true,
        twoFactorCodeRegex: null,
      },
    ],
    ...overrides,
  };
}

function message(projectId: ProjectId | null): CapturedEmailSummary {
  return {
    id: "msg_1" as EmailMessageId,
    attribution: {
      projectId,
      mailSlug: null,
      matchedBy: projectId === null ? "unassigned" : "auth-username",
      matchedValue: null,
    },
    from: [{ address: "noreply@example.com", name: "Example Auth" }],
    to: [{ address: "dev@pathway.test", name: null }],
    subject: "Your verification code",
    textPreview: "123456",
    receivedAt: "2026-08-12T10:00:00.000Z",
    sizeBytes: 1024,
    attachmentCount: 0,
    isRead: false,
    detectedCode: "123456",
  };
}

function rule(overrides?: Partial<EmailTriggerRule>): EmailTriggerRule {
  return {
    id: "rule_1" as EmailTriggerRuleId,
    name: "Password resets",
    enabled: true,
    matcher: { sender: "noreply@example.com", subject: null, recipient: null },
    promptTemplate: "Handle {{subject}}",
    maxTriggersPerHour: 5,
    rateLimitWindowStartedAt: null,
    triggersInCurrentWindow: 2,
    autoDisabledAt: null,
    autoDisabledReason: null,
    ...overrides,
  };
}

describe("emailCaptureAddress", () => {
  it("builds a reserved-domain address from a slug", () => {
    expect(emailCaptureAddress("pathway")).toBe("capture@pathway.test");
  });
});

describe("mailSlugError", () => {
  it("accepts a DNS-label slug", () => {
    expect(mailSlugError("my-app-2")).toBeNull();
  });

  it("names what is wrong with a rejected slug", () => {
    expect(mailSlugError("  ")).toBe("A mail slug is required.");
    expect(mailSlugError("My App")).toContain("lowercase");
    expect(mailSlugError("-leading")).toContain("lowercase");
    expect(mailSlugError("a".repeat(64))).toContain("at most 63");
  });
});

describe("withEmailProjectSettings", () => {
  it("patches one project and leaves the rest of the document alone", () => {
    const next = withEmailProjectSettings(settings(), PROJECT_ID, { toastMuted: true });

    expect(findEmailProjectSettings(next, PROJECT_ID)?.toastMuted).toBe(true);
    expect(findEmailProjectSettings(next, OTHER_PROJECT_ID)).toEqual(
      findEmailProjectSettings(settings(), OTHER_PROJECT_ID),
    );
    expect(next.listener).toEqual(settings().listener);
  });

  it("leaves a project the server has not derived an entry for untouched", () => {
    const next = withEmailProjectSettings(settings(), "prj_missing" as ProjectId, {
      toastMuted: true,
    });

    expect(next.projects).toHaveLength(2);
  });
});

describe("shouldToastCapturedEmail", () => {
  it("toasts before the first settings read lands", () => {
    expect(shouldToastCapturedEmail(null, message(PROJECT_ID))).toBe(true);
  });

  it("honours the master switch", () => {
    expect(shouldToastCapturedEmail(settings({ toastsEnabled: false }), message(PROJECT_ID))).toBe(
      false,
    );
  });

  it("honours a project mute and never mutes Unassigned", () => {
    expect(shouldToastCapturedEmail(settings(), message(OTHER_PROJECT_ID))).toBe(false);
    expect(shouldToastCapturedEmail(settings(), message(PROJECT_ID))).toBe(true);
    expect(shouldToastCapturedEmail(settings(), message(null))).toBe(true);
    expect(isEmailProjectMuted(settings(), OTHER_PROJECT_ID)).toBe(true);
  });
});

describe("emailSenderLabel", () => {
  it("prefers the display name and falls back to the address", () => {
    expect(emailSenderLabel(message(PROJECT_ID))).toBe("Example Auth");
    expect(
      emailSenderLabel({
        ...message(PROJECT_ID),
        from: [{ address: "bot@example.com", name: "  " }],
      }),
    ).toBe("bot@example.com");
    expect(emailSenderLabel({ ...message(PROJECT_ID), from: [] })).toBe("Unknown sender");
  });
});

describe("summarizeEmailListener", () => {
  const status = (overrides?: Partial<EmailListenerStatus>): EmailListenerStatus => ({
    state: "listening",
    bindAddress: "0.0.0.0",
    port: 1025,
    error: null,
    ...overrides,
  });

  it("spells out the bind address it is accepting on", () => {
    expect(summarizeEmailListener(status())).toEqual({
      tone: "listening",
      label: "Listening",
      detail: "Accepting SMTP on 0.0.0.0:1025.",
    });
  });

  it("surfaces a bind failure as an error with the server's reason", () => {
    const conflicted = status({
      state: "error",
      error: "SMTP capture could not bind 0.0.0.0:1025: the port is already in use.",
    });

    expect(summarizeEmailListener(conflicted).tone).toBe("error");
    expect(isEmailPortConflict(conflicted)).toBe(true);
    expect(isEmailPortConflict(status())).toBe(false);
    expect(isEmailPortConflict(status({ state: "error", error: "permission denied" }))).toBe(false);
  });

  it("reads a disabled listener as off rather than broken", () => {
    expect(summarizeEmailListener(status({ state: "disabled" })).tone).toBe("disabled");
  });
});

describe("number parsing", () => {
  it("takes whole numbers above zero only", () => {
    expect(parsePositiveInteger(" 12 ")).toBe(12);
    expect(parsePositiveInteger("0")).toBeNull();
    expect(parsePositiveInteger("-3")).toBeNull();
    expect(parsePositiveInteger("1.5")).toBeNull();
    expect(parsePositiveInteger("")).toBeNull();
  });

  it("keeps a port inside the addressable range", () => {
    expect(parsePort("1025")).toBe(1025);
    expect(parsePort("65536")).toBeNull();
  });

  it("reads a blank override as inherit", () => {
    expect(parseOptionalPositiveInteger("  ")).toEqual({ ok: true, value: null });
    expect(parseOptionalPositiveInteger("200")).toEqual({ ok: true, value: 200 });
    expect(parseOptionalPositiveInteger("nope")).toEqual({ ok: false });
  });
});

describe("validateEmailTriggerRuleDraft", () => {
  const draft = {
    ...EMPTY_EMAIL_TRIGGER_RULE_DRAFT,
    name: "Password resets",
    sender: " noreply@example.com ",
    promptTemplate: " Investigate {{subject}} ",
  };

  it("trims a valid draft into an upsert payload", () => {
    const result = validateEmailTriggerRuleDraft(draft, PROJECT_ID);

    expect(result).toEqual({
      ok: true,
      input: {
        projectId: PROJECT_ID,
        name: "Password resets",
        enabled: false,
        matcher: { sender: "noreply@example.com", subject: null, recipient: null },
        promptTemplate: "Investigate {{subject}}",
        maxTriggersPerHour: 5,
      },
    });
  });

  it("refuses a rule that would match every captured message", () => {
    const result = validateEmailTriggerRuleDraft({ ...draft, sender: "" }, PROJECT_ID);

    expect(result).toEqual({
      ok: false,
      error: "Match on at least one of sender, subject, or recipient.",
    });
  });

  it("requires a name, a prompt, and a whole hourly cap", () => {
    expect(validateEmailTriggerRuleDraft({ ...draft, name: " " }, PROJECT_ID).ok).toBe(false);
    expect(validateEmailTriggerRuleDraft({ ...draft, promptTemplate: "" }, PROJECT_ID).ok).toBe(
      false,
    );
    expect(
      validateEmailTriggerRuleDraft({ ...draft, maxTriggersPerHour: "0" }, PROJECT_ID).ok,
    ).toBe(false);
  });

  it("carries the id through when editing", () => {
    const result = validateEmailTriggerRuleDraft(emailTriggerRuleToDraft(rule()), PROJECT_ID);

    expect(result.ok && result.input.id).toBe("rule_1");
    expect(result.ok && result.input.enabled).toBe(true);
  });
});

describe("trigger rule presentation", () => {
  it("reads an auto-disabled rule as auto-disabled rather than paused", () => {
    expect(emailTriggerRuleState(rule())).toBe("enabled");
    expect(emailTriggerRuleState(rule({ enabled: false }))).toBe("paused");
    expect(
      emailTriggerRuleState(rule({ enabled: false, autoDisabledAt: "2026-08-12T10:00:00.000Z" })),
    ).toBe("auto-disabled");
  });

  it("describes a matcher in evaluation order", () => {
    expect(
      describeEmailTriggerMatcher({ sender: "a@b.com", subject: "Reset", recipient: null }),
    ).toBe("from a@b.com · subject Reset");
    expect(describeEmailTriggerMatcher({ sender: null, subject: null, recipient: null })).toBe(
      "Matches nothing",
    );
  });
});

describe("otherMailSlugs", () => {
  it("lists the slugs a rename would collide with", () => {
    expect(otherMailSlugs(settings(), PROJECT_ID)).toEqual(["storefront"]);
    expect(otherMailSlugs(null, PROJECT_ID)).toEqual([]);
  });
});
