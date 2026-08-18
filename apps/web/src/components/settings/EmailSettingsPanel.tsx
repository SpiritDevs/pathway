/**
 * Settings → Email: the listener, the retention defaults, the toast master switch, and trigger
 * rules for a chosen project.
 *
 * Email has its own settings group rather than living under System because direct mailbox
 * integration (Gmail, Outlook) lands here later and is clearly not a System concern.
 *
 * Every control writes the whole `EmailCaptureSettings` document, and the server answers with the
 * listener's real state — so a port that is already taken shows up here as an error on the port
 * field instead of the listener quietly moving somewhere no `.env` file points at.
 *
 * @module components/settings/EmailSettingsPanel
 */
import { TrustedEmailSenderEntity } from "@spiritdevs/client-runtime/sync";
import type { EmailCaptureSettings, ProjectId } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { BellIcon, MailIcon, RadioIcon, ShieldCheckIcon, Trash2Icon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useCapturedEmailAdmin } from "../../cloud/capturedEmailAdmin";
import { cloudEnvironmentProjectsFromReplicas } from "../../cloud/agentThreadReadModel";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEmailSettings, useUpdateEmailSettings } from "../../state/email";
import {
  isEmailPortConflict,
  parsePort,
  parsePositiveInteger,
  summarizeEmailListener,
} from "../email/emailSettings.logic";
import { ClearInboxButton } from "../email/ClearInboxButton";
import { EmailProjectCaptureSettings } from "../email/EmailProjectCaptureSettings";
import { EmailSettingField } from "../email/EmailSettingsField";
import { EmailTriggerRulesSection } from "../email/EmailTriggerRulesSection";
import { reportEmailWriteFailure } from "../email/emailWrites";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useCompanySettings } from "./company/useCompanySettings";

const LISTENER_TONE_CLASSES = {
  listening: "text-success-foreground",
  disabled: "text-muted-foreground",
  error: "text-destructive",
} as const;

export function EmailSettingsPanel() {
  const company = useCompanySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { settings, listenerStatus, error } = useEmailSettings();
  const updateSettings = useUpdateEmailSettings();
  const projects = useMemo(
    () =>
      company.companyId === null || company.replica === null || primaryEnvironmentId === null
        ? []
        : cloudEnvironmentProjectsFromReplicas(
            new Map([[company.companyId, company.replica]]),
            primaryEnvironmentId,
          ),
    [company.companyId, company.replica, primaryEnvironmentId],
  );
  const [ruleProjectId, setRuleProjectId] = useState<ProjectId | null>(null);

  const selectedProjectId = ruleProjectId ?? projects[0]?.id ?? null;
  const listener = summarizeEmailListener(listenerStatus);
  const portConflict = isEmailPortConflict(listenerStatus);

  /** Sends the whole document; true when it landed, which is what clears a field's draft. */
  const save = async (next: EmailCaptureSettings): Promise<boolean> =>
    reportEmailWriteFailure(
      "Could not save capture settings",
      await updateSettings({ settings: next }),
    );

  if (settings === null) {
    return (
      <SettingsPageContainer className="max-w-3xl">
        <SettingsSection icon={<MailIcon className="size-3.5" />} title="Local SMTP capture">
          <p className="px-3 py-6 text-center text-xs text-muted-foreground sm:px-4">
            {error ??
              "Capture settings live on the machine running the server, so there is nothing to configure until this client is connected to one."}
          </p>
        </SettingsSection>
        <TrustedEmailSendersSettingsSection />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer className="max-w-3xl">
      <SettingsSection
        {...searchableSetting("email-listener")}
        icon={<RadioIcon className="size-3.5" />}
      >
        <SettingsRow
          control={
            <Switch
              aria-label="SMTP listener"
              checked={settings.listener.enabled}
              onCheckedChange={(checked) =>
                void save({ ...settings, listener: { ...settings.listener, enabled: checked } })
              }
            />
          }
          description="Point a local app's SMTP host at this machine and everything it sends is captured here instead of reaching a real mailbox. The listener never relays."
          status={
            <span className={cn(LISTENER_TONE_CLASSES[listener.tone])}>
              {listener.label} — {listener.detail}
            </span>
          }
          title="Accept SMTP"
        />

        <SettingsRow
          control={
            <EmailSettingField
              ariaLabel="SMTP bind address"
              disabled={!settings.listener.enabled}
              onCommit={(draft) =>
                save({ ...settings, listener: { ...settings.listener, bindAddress: draft.trim() } })
              }
              validate={(draft) =>
                draft.trim().length === 0 ? "A bind address is required." : null
              }
              value={settings.listener.bindAddress}
            />
          }
          description="0.0.0.0 is the default and is what makes the listener reachable from Docker on Linux and from another machine on the network. Use 127.0.0.1 to keep it on this host only."
          title="Bind address"
        />

        <SettingsRow
          {...searchableSetting("email-listener-port")}
          control={
            <EmailSettingField
              ariaLabel="SMTP port"
              disabled={!settings.listener.enabled}
              inputMode="numeric"
              onCommit={(draft) => {
                const port = parsePort(draft);
                if (port === null) return Promise.resolve(false);
                return save({ ...settings, listener: { ...settings.listener, port } });
              }}
              validate={(draft) =>
                parsePort(draft) === null ? "Enter a port between 1 and 65535." : null
              }
              value={String(settings.listener.port)}
            />
          }
          description="The port never shifts on its own — .env files across projects depend on it staying put — so a conflict is reported rather than worked around."
          status={
            portConflict ? (
              <span className="text-destructive">
                {listenerStatus?.error ?? "The port is already in use."} Free it, or pick another
                port and update the apps that send here.
              </span>
            ) : null
          }
          title="Port"
        />
      </SettingsSection>

      <TrustedEmailSendersSettingsSection />

      <SettingsSection
        {...searchableSetting("email-retention")}
        icon={<Trash2Icon className="size-3.5" />}
      >
        <SettingsRow
          control={
            <EmailSettingField
              ariaLabel="Messages kept per inbox"
              inputMode="numeric"
              onCommit={(draft) => {
                const maxMessages = parsePositiveInteger(draft);
                if (maxMessages === null) return Promise.resolve(false);
                return save({ ...settings, retention: { ...settings.retention, maxMessages } });
              }}
              validate={(draft) =>
                parsePositiveInteger(draft) === null ? "Enter a whole number above zero." : null
              }
              value={String(settings.retention.maxMessages)}
            />
          }
          description="Per project inbox. Evicting a message deletes its source and attachments, so disk actually goes down. A project can override this on its own page."
          title="Messages per inbox"
        />
        <SettingsRow
          control={
            <EmailSettingField
              ariaLabel="Days of mail kept"
              inputMode="numeric"
              onCommit={(draft) => {
                const maxAgeDays = parsePositiveInteger(draft);
                if (maxAgeDays === null) return Promise.resolve(false);
                return save({ ...settings, retention: { ...settings.retention, maxAgeDays } });
              }}
              validate={(draft) =>
                parsePositiveInteger(draft) === null ? "Enter a whole number above zero." : null
              }
              value={String(settings.retention.maxAgeDays)}
            />
          }
          description="Whichever cap is reached first wins."
          title="Days kept"
        />
        <SettingsRow
          control={
            <ClearInboxButton
              inboxName="all inboxes"
              label="Clear all mail"
              scope={{ type: "all" }}
            />
          }
          description="Deletes every captured message across every inbox, including raw sources and attachments. Per-project clearing lives on each project's page."
          title="Clear all captured mail"
        />
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("email-toasts")}
        icon={<BellIcon className="size-3.5" />}
      >
        <SettingsRow
          control={
            <Switch
              aria-label="Capture toasts"
              checked={settings.toastsEnabled}
              onCheckedChange={(checked) => void save({ ...settings, toastsEnabled: checked })}
            />
          }
          description="Every captured email raises a toast from any route, showing the sender and any detected verification code with one-click copy. Mute a chatty project from its row in the Email sidebar; this switch turns them all off."
          title="Toast on captured mail"
        />
      </SettingsSection>

      <EmailProjectCaptureSettings projects={projects} save={save} settings={settings} />

      <EmailTriggerRulesSection
        headerContent={
          projects.length === 0 ? null : (
            <Select
              onValueChange={(value) => setRuleProjectId((value as ProjectId | null) ?? null)}
              value={selectedProjectId ?? ""}
            >
              <SelectTrigger size="sm">
                <SelectValue placeholder="Select a project">
                  {projects.find((project) => project.id === selectedProjectId)?.title}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )
        }
        projectId={selectedProjectId}
        sectionId={searchableSetting("email-trigger-rules").id}
        title={searchableSetting("email-trigger-rules").title}
      />
    </SettingsPageContainer>
  );
}

function TrustedEmailSendersSettingsSection() {
  const company = useCompanySettings();
  const senders = useMemo(() => {
    const companyId = company.companyId;
    if (companyId === null || company.replica === null) return [];
    const isTrustedSender = Schema.is(TrustedEmailSenderEntity);
    return [...company.replica.view.values()].flatMap((value) =>
      isTrustedSender(value)
        ? [
            {
              id: value.id,
              address: value.address,
              companyId,
            },
          ]
        : [],
    );
  }, [company.companyId, company.replica]);
  const emailAdmin = useCapturedEmailAdmin();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (sender: (typeof senders)[number]) => {
    if (emailAdmin === null || removingId !== null) return;
    setRemovingId(sender.id);
    setError(null);
    try {
      await emailAdmin.removeTrustedSender(sender.companyId, sender.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <SettingsSection
      {...searchableSetting("email-trusted-senders")}
      icon={<ShieldCheckIcon className="size-3.5" />}
    >
      <SettingsRow
        description="Clicking Load remote content trusts that exact From address. Trusted senders load images and styles automatically and sync through Convex to every environment in this company."
        status={
          error ??
          (emailAdmin === null
            ? "Connect and sign in to company sync to change trusted senders."
            : null)
        }
        title="Trusted senders"
      >
        <div className="mt-3 overflow-hidden rounded-lg border border-border/60">
          {senders.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">No senders are trusted yet.</p>
          ) : (
            senders.map((sender) => (
              <div
                className="flex min-h-9 items-center gap-3 border-b border-border/50 px-3 last:border-b-0"
                key={sender.id}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {sender.address}
                </span>
                <Button
                  aria-label={`Stop trusting ${sender.address}`}
                  disabled={emailAdmin === null || removingId !== null}
                  onClick={() => void remove(sender)}
                  size="icon-xs"
                  title="Stop loading remote content automatically"
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            ))
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
