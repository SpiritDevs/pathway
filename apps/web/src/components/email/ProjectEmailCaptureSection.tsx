/**
 * A project's own capture settings, rendered inside `ProjectSettingsPanel`.
 *
 * Everything here is a per-project view of the one capture settings document: the mail slug that
 * routes to this inbox, the retention caps it overrides, the 2FA pattern it prefers, whether its
 * captures toast, and the rules its mail may start threads from.
 *
 * Capture runs on the primary environment's host, so this renders for the checkout that lives
 * there and nothing else — a remote checkout of the same project has no inbox of its own.
 *
 * @module components/email/ProjectEmailCaptureSection
 */
import type { EmailCaptureSettings, EmailMailSlug, ProjectId } from "@t3tools/contracts";
import { BellIcon, CopyIcon, MailIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEmailSettings, useUpdateEmailSettings } from "~/state/email";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import {
  emailCaptureAddress,
  findEmailProjectSettings,
  mailSlugError,
  otherMailSlugs,
  parseOptionalPositiveInteger,
  withEmailProjectSettings,
} from "./emailSettings.logic";
import { ClearInboxButton } from "./ClearInboxButton";
import { EmailSettingField } from "./EmailSettingsField";
import { EmailTriggerRulesSection } from "./EmailTriggerRulesSection";
import { reportEmailWriteFailure } from "./emailWrites";

/** Compiling the pattern here is the validation; the server owns applying it to captured mail. */
function regexError(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null;
  try {
    RegExp(trimmed);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "That is not a valid regular expression.";
  }
}

export function ProjectEmailCaptureSection({
  projectId,
  projectName,
}: {
  projectId: ProjectId;
  projectName: string;
}) {
  const { settings } = useEmailSettings();
  const updateSettings = useUpdateEmailSettings();
  const { copyToClipboard } = useCopyToClipboard<{ address: string }>({
    target: "capture address",
    onCopy: ({ address }) => {
      toastManager.add({ type: "success", title: "Capture address copied", description: address });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy the capture address",
          description: error.message,
        }),
      );
    },
  });

  const project = findEmailProjectSettings(settings, projectId);

  const save = async (next: EmailCaptureSettings): Promise<boolean> =>
    reportEmailWriteFailure(
      "Could not save capture settings",
      await updateSettings({ settings: next }),
    );

  const patch = (
    values: Partial<Omit<NonNullable<typeof project>, "projectId">>,
  ): Promise<boolean> =>
    settings === null
      ? Promise.resolve(false)
      : save(withEmailProjectSettings(settings, projectId, values));

  if (settings === null || project === null) {
    return (
      <SettingsSection icon={<MailIcon className="size-3.5" />} title="Email capture">
        <p className="px-3 py-6 text-xs text-muted-foreground sm:px-4">
          This project has no capture inbox yet. One is created — with an address derived from its
          directory — the next time the server reads its capture settings.
        </p>
      </SettingsSection>
    );
  }

  const captureAddress = emailCaptureAddress(project.mailSlug);
  const takenSlugs = otherMailSlugs(settings, projectId);

  return (
    <>
      <SettingsSection icon={<MailIcon className="size-3.5" />} title="Email capture">
        <SettingsRow
          control={
            <EmailSettingField
              ariaLabel="Mail slug"
              onCommit={(draft) => patch({ mailSlug: draft.trim() as EmailMailSlug })}
              validate={(draft) =>
                mailSlugError(draft) ??
                (takenSlugs.includes(draft.trim() as EmailMailSlug)
                  ? "Another project already uses that slug."
                  : null)
              }
              value={project.mailSlug}
            />
          }
          description="Mail routes to this project when the SMTP AUTH username is the slug, when a recipient uses it as a domain, or when a recipient carries it as a plus tag."
          title="Mail slug"
        />

        <SettingsRow
          control={
            <Button
              onClick={() => copyToClipboard(captureAddress, { address: captureAddress })}
              size="sm"
              variant="outline"
            >
              <CopyIcon aria-hidden="true" />
              Copy address
            </Button>
          }
          description={
            <>
              Anything sent to <span className="font-mono">{captureAddress}</span> lands in this
              inbox. <span className="font-mono">.test</span> is reserved, so a stray real send can
              never leave the machine.
            </>
          }
          title="Capture address"
        />

        <SettingsRow
          control={
            <EmailSettingField
              ariaLabel="Messages kept for this project"
              inputMode="numeric"
              onCommit={(draft) => {
                const parsed = parseOptionalPositiveInteger(draft);
                if (!parsed.ok) return Promise.resolve(false);
                return patch({
                  retention: { ...project.retention, maxMessages: parsed.value },
                });
              }}
              placeholder={`Inherit (${settings.retention.maxMessages})`}
              validate={(draft) =>
                parseOptionalPositiveInteger(draft).ok
                  ? null
                  : "Enter a whole number above zero, or leave it blank to inherit."
              }
              value={
                project.retention.maxMessages === null ? "" : String(project.retention.maxMessages)
              }
            />
          }
          description="Overrides the central cap for this inbox only. Blank inherits it."
          resetAction={
            project.retention.maxMessages === null ? null : (
              <SettingResetButton
                label="message cap"
                onClick={() =>
                  void patch({ retention: { ...project.retention, maxMessages: null } })
                }
              />
            )
          }
          title="Messages kept"
        />

        <SettingsRow
          control={
            <EmailSettingField
              ariaLabel="Days of mail kept for this project"
              inputMode="numeric"
              onCommit={(draft) => {
                const parsed = parseOptionalPositiveInteger(draft);
                if (!parsed.ok) return Promise.resolve(false);
                return patch({ retention: { ...project.retention, maxAgeDays: parsed.value } });
              }}
              placeholder={`Inherit (${settings.retention.maxAgeDays})`}
              validate={(draft) =>
                parseOptionalPositiveInteger(draft).ok
                  ? null
                  : "Enter a whole number above zero, or leave it blank to inherit."
              }
              value={
                project.retention.maxAgeDays === null ? "" : String(project.retention.maxAgeDays)
              }
            />
          }
          description="Whichever cap is reached first wins."
          resetAction={
            project.retention.maxAgeDays === null ? null : (
              <SettingResetButton
                label="age cap"
                onClick={() =>
                  void patch({ retention: { ...project.retention, maxAgeDays: null } })
                }
              />
            )
          }
          title="Days kept"
        />

        <SettingsRow
          control={
            <EmailSettingField
              ariaLabel="Verification code pattern"
              className="sm:w-72"
              onCommit={(draft) =>
                patch({ twoFactorCodeRegex: draft.trim().length === 0 ? null : draft.trim() })
              }
              placeholder="Built-in detection"
              validate={regexError}
              value={project.twoFactorCodeRegex ?? ""}
            />
          }
          description="Detection works with no setup — an agent hitting a login flow blind cannot configure anything first. Set a pattern here for the app you test daily, or to fix a false positive. The first capture group is the code."
          resetAction={
            project.twoFactorCodeRegex === null ? null : (
              <SettingResetButton
                label="code pattern"
                onClick={() => void patch({ twoFactorCodeRegex: null })}
              />
            )
          }
          title="Verification code pattern"
        />

        <SettingsRow
          control={
            <Switch
              aria-label={`Capture toasts for ${projectName}`}
              checked={!project.toastMuted}
              onCheckedChange={(checked) => void patch({ toastMuted: !checked })}
            />
          }
          description="Off silences this project's captures everywhere without touching the others. The same toggle sits on its row in the Email sidebar."
          status={
            settings.toastsEnabled ? null : (
              <span className="inline-flex items-center gap-1">
                <BellIcon aria-hidden="true" className="size-3" />
                Toasts are off for every project in Email settings.
              </span>
            )
          }
          title="Toast on captured mail"
        />

        <SettingsRow
          control={
            <ClearInboxButton
              inboxName={`${projectName} inbox`}
              scope={{ type: "project", projectId }}
            />
          }
          description="Deletes every captured message in this project's inbox, including raw sources and attachments."
          title="Clear inbox"
        />
      </SettingsSection>

      <EmailTriggerRulesSection projectId={projectId} title="Mail trigger rules" />
    </>
  );
}
