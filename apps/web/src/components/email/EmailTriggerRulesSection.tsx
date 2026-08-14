/**
 * Project trigger rules: a matching message starts a fresh thread from a prompt template.
 *
 * The listener binds every interface and accepts any credentials, so this screen is the visible
 * half of the three guards the design put around that: a rule is created disabled, carries an
 * hourly cap, and auto-disables when its own run produces a message it matches. The firing log
 * underneath is what makes a misfiring rule diagnosable instead of mysterious.
 *
 * Rendered both centrally (Settings → Email, for a chosen project) and on a project's own page.
 *
 * @module components/email/EmailTriggerRulesSection
 */
import type { EmailTriggerFiring, EmailTriggerRule, ProjectId } from "@spiritdevs/contracts";
import { PencilIcon, PlusIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  useDeleteEmailTriggerRule,
  useEmailTriggerFirings,
  useEmailTriggerRules,
  useUpsertEmailTriggerRule,
} from "~/state/email";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsSection, useRelativeTimeTick } from "../settings/settingsLayout";
import {
  describeEmailTriggerMatcher,
  EMAIL_TRIGGER_FIRING_STATUS_LABELS,
  EMAIL_TRIGGER_RULE_STATE_LABELS,
  emailTriggerRuleRateLimitLabel,
  emailTriggerRuleState,
  emailTriggerRuleToDraft,
  EMPTY_EMAIL_TRIGGER_RULE_DRAFT,
  validateEmailTriggerRuleDraft,
  type EmailTriggerRuleDraft,
} from "./emailSettings.logic";
import { reportEmailWriteFailure } from "./emailWrites";

/** The variables a template can interpolate, spelled out where the template is written. */
const PROMPT_VARIABLES = ["sender", "subject", "body", "code", "messageId"] as const;

const STATE_BADGE_VARIANTS = {
  enabled: "success",
  paused: "outline",
  "auto-disabled": "warning",
} as const;

const FIRING_BADGE_VARIANTS = {
  launched: "success",
  failed: "error",
  "loop-detected": "warning",
} as const;

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        className="flex items-baseline justify-between gap-2 text-xs font-medium text-foreground"
        htmlFor={htmlFor}
      >
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-[11px] text-muted-foreground/80">{hint}</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

export function EmailTriggerRulesSection({
  projectId,
  sectionId,
  title = "Trigger rules",
  headerContent,
}: {
  /** Null while no project is chosen; the section then explains itself instead of listing. */
  projectId: ProjectId | null;
  sectionId?: string;
  title?: string;
  /** Rendered left of the New button — the central page puts its project picker here. */
  headerContent?: ReactNode;
}) {
  useRelativeTimeTick(30_000);
  const { rules, error } = useEmailTriggerRules(projectId);
  const { firings } = useEmailTriggerFirings(projectId);
  const upsertRule = useUpsertEmailTriggerRule();
  const deleteRule = useDeleteEmailTriggerRule();

  const [draft, setDraft] = useState<EmailTriggerRuleDraft>(EMPTY_EMAIL_TRIGGER_RULE_DRAFT);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openForCreate = () => {
    setDraft(EMPTY_EMAIL_TRIGGER_RULE_DRAFT);
    setDraftError(null);
    setDialogOpen(true);
  };

  const openForEdit = (rule: EmailTriggerRule) => {
    setDraft(emailTriggerRuleToDraft(rule));
    setDraftError(null);
    setDialogOpen(true);
  };

  const submit = async () => {
    if (projectId === null || saving) return;
    const validated = validateEmailTriggerRuleDraft(draft, projectId);
    if (!validated.ok) {
      setDraftError(validated.error);
      return;
    }
    setSaving(true);
    const result = await upsertRule(validated.input);
    setSaving(false);
    if (!reportEmailWriteFailure("Could not save the trigger rule", result)) return;
    setDialogOpen(false);
  };

  /** Toggling from the list is a one-field edit, so it never opens the dialog. */
  const setRuleEnabled = async (rule: EmailTriggerRule, enabled: boolean) => {
    if (projectId === null) return;
    const result = await upsertRule({
      id: rule.id,
      projectId,
      name: rule.name,
      enabled,
      matcher: rule.matcher,
      promptTemplate: rule.promptTemplate,
      maxTriggersPerHour: rule.maxTriggersPerHour,
    });
    reportEmailWriteFailure("Could not change the trigger rule", result);
  };

  const removeRule = async (rule: EmailTriggerRule) => {
    if (projectId === null) return;
    const result = await deleteRule({ projectId, ruleId: rule.id });
    reportEmailWriteFailure("Could not delete the trigger rule", result);
  };

  return (
    <SettingsSection
      headerAction={
        <div className="flex items-center gap-2">
          {headerContent}
          <Button disabled={projectId === null} onClick={openForCreate} size="xs" variant="outline">
            <PlusIcon className="size-3.5" />
            New
          </Button>
        </div>
      }
      icon={<ZapIcon className="size-3.5" />}
      id={sectionId}
      title={title}
    >
      {projectId === null ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground sm:px-4">
          Pick a project to manage the rules that start threads from its captured mail.
        </p>
      ) : error !== null ? (
        <p className="px-3 py-4 text-xs text-destructive sm:px-4">{error}</p>
      ) : rules.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground sm:px-4">
          No rules yet. A rule starts a fresh thread in this project when a captured message matches
          its sender, subject, or recipient.
        </p>
      ) : (
        <div className="divide-y divide-border/60">
          {rules.map((rule) => {
            const state = emailTriggerRuleState(rule);
            return (
              <div
                className="grid gap-3 px-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-4"
                key={rule.id}
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-foreground">{rule.name}</h3>
                    <Badge variant={STATE_BADGE_VARIANTS[state]}>
                      {EMAIL_TRIGGER_RULE_STATE_LABELS[state]}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {describeEmailTriggerMatcher(rule.matcher)}
                  </p>
                  <p className="line-clamp-2 text-xs text-muted-foreground/80">
                    {rule.promptTemplate}
                  </p>
                  <p className="text-[11px] text-muted-foreground/80">
                    {emailTriggerRuleRateLimitLabel(rule)}
                  </p>
                  {rule.autoDisabledReason === null ? null : (
                    <p className="text-[11px] text-warning-foreground">{rule.autoDisabledReason}</p>
                  )}
                </div>
                <div className="flex items-start gap-1">
                  <Switch
                    aria-label={rule.enabled ? `Disable ${rule.name}` : `Enable ${rule.name}`}
                    checked={rule.enabled}
                    className="mt-1"
                    onCheckedChange={(checked) => void setRuleEnabled(rule, checked)}
                  />
                  <Button
                    aria-label={`Edit ${rule.name}`}
                    onClick={() => openForEdit(rule)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    aria-label={`Delete ${rule.name}`}
                    onClick={() => void removeRule(rule)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {projectId === null ? null : <EmailTriggerFiringLog firings={firings} rules={rules} />}

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft.editingId === null ? "New rule" : "Edit rule"}</DialogTitle>
            <DialogDescription>
              A matching message starts a new thread in this project from the prompt below.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-5">
            <Field htmlFor="email-trigger-name" label="Name">
              <Input
                id="email-trigger-name"
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                placeholder="e.g. Sign-up confirmations"
                value={draft.name}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field htmlFor="email-trigger-sender" label="Sender">
                <Input
                  id="email-trigger-sender"
                  onChange={(event) => setDraft({ ...draft, sender: event.currentTarget.value })}
                  placeholder="noreply@example.com"
                  value={draft.sender}
                />
              </Field>
              <Field htmlFor="email-trigger-subject" label="Subject">
                <Input
                  id="email-trigger-subject"
                  onChange={(event) => setDraft({ ...draft, subject: event.currentTarget.value })}
                  placeholder="Verify your email"
                  value={draft.subject}
                />
              </Field>
              <Field htmlFor="email-trigger-recipient" label="Recipient">
                <Input
                  id="email-trigger-recipient"
                  onChange={(event) => setDraft({ ...draft, recipient: event.currentTarget.value })}
                  placeholder="qa@my-app.test"
                  value={draft.recipient}
                />
              </Field>
            </div>

            <Field
              hint={PROMPT_VARIABLES.map((variable) => `{{${variable}}}`).join(" ")}
              htmlFor="email-trigger-prompt"
              label="Prompt"
            >
              <Textarea
                id="email-trigger-prompt"
                onChange={(event) =>
                  setDraft({ ...draft, promptTemplate: event.currentTarget.value })
                }
                placeholder="A verification email arrived from {{sender}}. Use {{code}} to finish the login flow."
                value={draft.promptTemplate}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                hint="Loop protection"
                htmlFor="email-trigger-rate-limit"
                label="Max runs per hour"
              >
                <Input
                  id="email-trigger-rate-limit"
                  inputMode="numeric"
                  onChange={(event) =>
                    setDraft({ ...draft, maxTriggersPerHour: event.currentTarget.value })
                  }
                  value={draft.maxTriggersPerHour}
                />
              </Field>
              <Field label="Enabled">
                <div className="flex h-8.5 items-center gap-2 sm:h-7.5">
                  <Switch
                    aria-label="Rule enabled"
                    checked={draft.enabled}
                    onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
                  />
                  <span className="text-xs text-muted-foreground">
                    {draft.enabled ? "Starts threads on a match" : "Matches nothing while off"}
                  </span>
                </div>
              </Field>
            </div>

            {draftError === null ? null : <p className="text-xs text-destructive">{draftError}</p>}
          </DialogPanel>

          <DialogFooter>
            <DialogClose
              render={
                <Button size="sm" variant="ghost">
                  Cancel
                </Button>
              }
            />
            <Button disabled={saving} onClick={() => void submit()} size="sm">
              {draft.editingId === null ? "Create rule" : "Save rule"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

const FIRING_LOG_LIMIT = 8;

function EmailTriggerFiringLog({
  firings,
  rules,
}: {
  firings: ReadonlyArray<EmailTriggerFiring>;
  rules: ReadonlyArray<EmailTriggerRule>;
}) {
  if (firings.length === 0) return null;
  const ruleNames = new Map(rules.map((rule) => [rule.id, rule.name]));

  return (
    <div className="mt-2 border-t border-border/60 px-3 pt-3 sm:px-4">
      <h3 className="text-xs font-medium text-foreground">Recent firings</h3>
      <ul className="mt-2 space-y-1.5">
        {firings.slice(0, FIRING_LOG_LIMIT).map((firing) => (
          <li className="flex min-w-0 items-center gap-2 text-xs" key={firing.id}>
            <Badge size="sm" variant={FIRING_BADGE_VARIANTS[firing.status]}>
              {EMAIL_TRIGGER_FIRING_STATUS_LABELS[firing.status]}
            </Badge>
            <span className="truncate text-muted-foreground">
              {ruleNames.get(firing.ruleId) ?? "Deleted rule"}
            </span>
            <span className="ms-auto shrink-0 text-muted-foreground/70 tabular-nums">
              {formatRelativeTimeLabel(firing.firedAt)}
            </span>
          </li>
        ))}
      </ul>
      {firings.some((firing) => firing.error !== null) ? (
        <ul className="mt-2 space-y-1">
          {firings
            .slice(0, FIRING_LOG_LIMIT)
            .filter((firing) => firing.error !== null)
            .map((firing) => (
              <li className="text-[11px] text-destructive" key={`${firing.id}:error`}>
                {firing.error}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
