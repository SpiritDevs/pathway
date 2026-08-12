/**
 * Everything the capture settings screens decide without the DOM: editing the settings document,
 * reading the listener's state, and turning a trigger-rule form into a contract payload.
 *
 * Capture settings are one document (`EmailCaptureSettings`) that every writer sends whole, so the
 * edits here are expressed as functions from the current document to the next one. That keeps the
 * three places that write it — the sidebar's mutes, the Email settings page, and a project's own
 * page — from each inventing a different merge.
 *
 * @module components/email/emailSettings.logic
 */
import {
  EMAIL_MAIL_SLUG_MAX_LENGTH,
  type CapturedEmailSummary,
  type EmailCaptureSettings,
  type EmailListenerStatus,
  type EmailMailSlug,
  type EmailProjectSettings,
  type EmailTriggerFiring,
  type EmailTriggerRule,
  type EmailTriggerRuleId,
  type EmailTriggerRuleUpsertInput,
  type ProjectId,
} from "@t3tools/contracts";

// ── Addresses ──────────────────────────────────────────────────────────

/** RFC 6761 reserves `.test`, so a stray real send can never leave the machine. */
export const EMAIL_CAPTURE_DOMAIN_SUFFIX = ".test";
/** The local part is ignored by routing; a readable one makes the copied address self-explanatory. */
const CAPTURE_ADDRESS_LOCAL_PART = "capture";

export function emailCaptureAddress(mailSlug: string): string {
  return `${CAPTURE_ADDRESS_LOCAL_PART}@${mailSlug}${EMAIL_CAPTURE_DOMAIN_SUFFIX}`;
}

const MAIL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The SMTP host an app is pointed at.
 *
 * A wildcard bind is what a socket listens on, not something an app can dial, so it reads as
 * localhost here. Docker containers and other machines reach the same listener at this machine's
 * own address, which only the person wiring it up knows — so the field says so rather than guessing.
 */
export function emailSmtpHostLabel(bindAddress: string): string {
  const bind = bindAddress.trim();
  return bind.length === 0 || bind === "0.0.0.0" || bind === "::" ? "localhost" : bind;
}

/** The rejection reason for a hand-edited slug, or null when it is usable. */
export function mailSlugError(value: string): string | null {
  const slug = value.trim();
  if (slug.length === 0) return "A mail slug is required.";
  if (slug.length > EMAIL_MAIL_SLUG_MAX_LENGTH) {
    return `A mail slug is at most ${EMAIL_MAIL_SLUG_MAX_LENGTH} characters.`;
  }
  if (!MAIL_SLUG_PATTERN.test(slug)) {
    return "Use lowercase letters, digits, and dashes, starting and ending with a letter or digit.";
  }
  return null;
}

// ── The settings document ──────────────────────────────────────────────

export function findEmailProjectSettings(
  settings: EmailCaptureSettings | null,
  projectId: ProjectId | null,
): EmailProjectSettings | null {
  if (settings === null || projectId === null) return null;
  return settings.projects.find((project) => project.projectId === projectId) ?? null;
}

/**
 * Patches one project's entry.
 *
 * A project with no entry yet is left alone rather than invented here: the server derives an entry
 * (and its collision-free slug) for every project on read, so a client that guessed would be
 * racing that derivation with a slug it cannot know is free.
 */
export function withEmailProjectSettings(
  settings: EmailCaptureSettings,
  projectId: ProjectId,
  patch: Partial<Omit<EmailProjectSettings, "projectId">>,
): EmailCaptureSettings {
  return {
    ...settings,
    projects: settings.projects.map((project) =>
      project.projectId === projectId ? { ...project, ...patch } : project,
    ),
  };
}

export function isEmailProjectMuted(
  settings: EmailCaptureSettings | null,
  projectId: ProjectId | null,
): boolean {
  return findEmailProjectSettings(settings, projectId)?.toastMuted ?? false;
}

/**
 * Whether a captured message gets a toast.
 *
 * Unassigned mail is never muted: it has no project to carry a mute, and it is the case most worth
 * seeing — something addressed the listener in a way no project claimed.
 */
export function shouldToastCapturedEmail(
  settings: EmailCaptureSettings | null,
  message: CapturedEmailSummary,
): boolean {
  // Until the first settings read lands, toast: the default is on, and swallowing the first
  // verification code of a session is the expensive mistake.
  if (settings === null) return true;
  if (!settings.toastsEnabled) return false;
  return !isEmailProjectMuted(settings, message.attribution.projectId);
}

/** The sender a toast leads with, preferring the display name a mail client would show. */
export function emailSenderLabel(message: CapturedEmailSummary): string {
  const sender = message.from[0];
  if (sender === undefined) return "Unknown sender";
  const name = sender.name?.trim() ?? "";
  return name.length > 0 ? name : sender.address;
}

export function emailSubjectLabel(message: CapturedEmailSummary): string {
  const subject = message.subject?.trim() ?? "";
  return subject.length > 0 ? subject : "(no subject)";
}

// ── Listener ───────────────────────────────────────────────────────────

export interface EmailListenerSummary {
  readonly tone: "listening" | "disabled" | "error";
  readonly label: string;
  /** The bind is worth spelling out: `0.0.0.0` is what makes Docker and other machines reach it. */
  readonly detail: string;
}

export function summarizeEmailListener(status: EmailListenerStatus | null): EmailListenerSummary {
  if (status === null) {
    return { tone: "disabled", label: "Unknown", detail: "The listener has not reported yet." };
  }
  const address = `${status.bindAddress}:${status.port}`;
  if (status.state === "error") {
    return {
      tone: "error",
      label: "Not listening",
      detail: status.error ?? `SMTP capture could not bind ${address}.`,
    };
  }
  if (status.state === "disabled") {
    return {
      tone: "disabled",
      label: "Off",
      detail: "Nothing is accepting SMTP on this machine.",
    };
  }
  return { tone: "listening", label: "Listening", detail: `Accepting SMTP on ${address}.` };
}

/**
 * Whether the listener failed because something else owns the port.
 *
 * The port never silently shifts — `.env` files across projects depend on it staying put — so this
 * is what puts the error on the port field instead of only in the status line.
 */
export function isEmailPortConflict(status: EmailListenerStatus | null): boolean {
  return status?.state === "error" && (status.error ?? "").toLowerCase().includes("in use");
}

// ── Numeric fields ─────────────────────────────────────────────────────

/** Parses a whole number above zero from a text field; null for anything else. */
export function parsePositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parsePort(value: string): number | null {
  const parsed = parsePositiveInteger(value);
  return parsed !== null && parsed <= 65535 ? parsed : null;
}

/** An override field: blank means inherit, which is a value rather than a parse failure. */
export function parseOptionalPositiveInteger(
  value: string,
): { readonly ok: true; readonly value: number | null } | { readonly ok: false } {
  if (value.trim().length === 0) return { ok: true, value: null };
  const parsed = parsePositiveInteger(value);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

// ── Trigger rules ──────────────────────────────────────────────────────

export interface EmailTriggerRuleDraft {
  readonly editingId: EmailTriggerRuleId | null;
  readonly name: string;
  readonly enabled: boolean;
  readonly sender: string;
  readonly subject: string;
  readonly recipient: string;
  readonly promptTemplate: string;
  readonly maxTriggersPerHour: string;
}

/**
 * A new rule starts disabled and capped.
 *
 * The listener binds every interface and accepts any credentials, so a rule is a path from "anyone
 * who can reach the port" to "agent work runs". Off by default is the first of the three guards.
 */
export const EMPTY_EMAIL_TRIGGER_RULE_DRAFT: EmailTriggerRuleDraft = Object.freeze({
  editingId: null,
  name: "",
  enabled: false,
  sender: "",
  subject: "",
  recipient: "",
  promptTemplate: "",
  maxTriggersPerHour: "5",
});

export function emailTriggerRuleToDraft(rule: EmailTriggerRule): EmailTriggerRuleDraft {
  return {
    editingId: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    sender: rule.matcher.sender ?? "",
    subject: rule.matcher.subject ?? "",
    recipient: rule.matcher.recipient ?? "",
    promptTemplate: rule.promptTemplate,
    maxTriggersPerHour: String(rule.maxTriggersPerHour),
  };
}

export type EmailTriggerRuleValidation =
  | { readonly ok: true; readonly input: EmailTriggerRuleUpsertInput }
  | { readonly ok: false; readonly error: string };

const optionalMatcherField = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Turns a draft into an upsert payload.
 *
 * A rule with an empty matcher is rejected rather than treated as "match everything": that shape is
 * exactly the runaway the plan refuses to build, and an accidental blank field should not create it.
 */
export function validateEmailTriggerRuleDraft(
  draft: EmailTriggerRuleDraft,
  projectId: ProjectId,
): EmailTriggerRuleValidation {
  const name = draft.name.trim();
  if (name.length === 0) return { ok: false, error: "Give the rule a name." };

  const promptTemplate = draft.promptTemplate.trim();
  if (promptTemplate.length === 0) {
    return { ok: false, error: "A rule needs a prompt for the thread it starts." };
  }

  const matcher = {
    sender: optionalMatcherField(draft.sender),
    subject: optionalMatcherField(draft.subject),
    recipient: optionalMatcherField(draft.recipient),
  };
  if (matcher.sender === null && matcher.subject === null && matcher.recipient === null) {
    return { ok: false, error: "Match on at least one of sender, subject, or recipient." };
  }

  const maxTriggersPerHour = parsePositiveInteger(draft.maxTriggersPerHour);
  if (maxTriggersPerHour === null) {
    return { ok: false, error: "The hourly cap must be a whole number above zero." };
  }

  return {
    ok: true,
    input: {
      ...(draft.editingId === null ? {} : { id: draft.editingId }),
      projectId,
      name,
      enabled: draft.enabled,
      matcher,
      promptTemplate,
      maxTriggersPerHour,
    },
  };
}

/** The matcher in one line, in the order the server evaluates it. */
export function describeEmailTriggerMatcher(matcher: EmailTriggerRule["matcher"]): string {
  const parts = [
    matcher.sender === null ? null : `from ${matcher.sender}`,
    matcher.subject === null ? null : `subject ${matcher.subject}`,
    matcher.recipient === null ? null : `to ${matcher.recipient}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Matches nothing" : parts.join(" · ");
}

export type EmailTriggerRuleState = "enabled" | "paused" | "auto-disabled";

/**
 * Auto-disabled outranks paused: a rule that tripped loop detection is off for a reason the user
 * did not choose, and saying only "Paused" would hide why it stopped firing.
 */
export function emailTriggerRuleState(rule: EmailTriggerRule): EmailTriggerRuleState {
  if (rule.autoDisabledAt !== null) return "auto-disabled";
  return rule.enabled ? "enabled" : "paused";
}

export const EMAIL_TRIGGER_RULE_STATE_LABELS: Readonly<Record<EmailTriggerRuleState, string>> = {
  enabled: "Enabled",
  paused: "Paused",
  "auto-disabled": "Auto-disabled",
};

export const EMAIL_TRIGGER_FIRING_STATUS_LABELS: Readonly<
  Record<EmailTriggerFiring["status"], string>
> = {
  launched: "Launched",
  failed: "Failed",
  "loop-detected": "Loop detected",
};

/** How much of the hourly cap this rule has spent, for the "3 of 5 this hour" line. */
export function emailTriggerRuleRateLimitLabel(rule: EmailTriggerRule): string {
  return `${rule.triggersInCurrentWindow} of ${rule.maxTriggersPerHour} this hour`;
}

/** Every project's slug except one, so a rename can be checked before it is sent. */
export function otherMailSlugs(
  settings: EmailCaptureSettings | null,
  projectId: ProjectId,
): ReadonlyArray<EmailMailSlug> {
  if (settings === null) return [];
  return settings.projects
    .filter((project) => project.projectId !== projectId)
    .map((project) => project.mailSlug);
}

// ── Capture password ───────────────────────────────────────────────────

/**
 * The AUTH password a project claims, or null for "route some other way".
 *
 * Emptying the field clears the routing label rather than storing a blank one: the contract holds a
 * trimmed non-empty string or null, and a project whose password is `""` would otherwise claim
 * every send from an app that authenticates without one.
 */
export function parseCapturePassword(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Every other project's capture password, so a collision can be caught before it is sent. */
export function otherCapturePasswords(
  settings: EmailCaptureSettings | null,
  projectId: ProjectId,
): ReadonlyArray<string> {
  if (settings === null) return [];
  return settings.projects
    .filter((project) => project.projectId !== projectId)
    .map((project) => project.capturePassword)
    .filter((password): password is string => password !== null);
}

/**
 * The rejection reason for a hand-edited capture password, or null when it is usable.
 *
 * Routing takes the first project whose password matches, so two projects sharing one would make
 * attribution depend on the order the document happens to be in — a misroute with no visible cause.
 */
export function capturePasswordError(
  value: string,
  takenPasswords: ReadonlyArray<string>,
): string | null {
  const password = parseCapturePassword(value);
  if (password === null) return null;
  return takenPasswords.includes(password)
    ? "Another project already routes with that password."
    : null;
}
