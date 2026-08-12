/**
 * Settings → Capture: everything an app has to be told to reach a project's inbox, per project.
 *
 * The flat address list this replaces answered "where does mail land" and nothing else — not what
 * goes in `SMTP_HOST`, not what goes in `SMTP_USER`, which is the question anyone wiring a dev
 * server up actually arrives with. So each project expands into the whole connection: host, port,
 * the username that routes, the optional password that also routes, the slug all three come from,
 * and whether its captures toast.
 *
 * Rows are collapsed by default and open one at a time by hand: a machine with a dozen projects
 * would otherwise bury the listener settings above under a wall of credentials.
 *
 * @module components/email/EmailProjectCaptureSettings
 */
import type { EmailCaptureSettings, EmailProjectSettings } from "@t3tools/contracts";
import { BellIcon, ChevronRightIcon, MailIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "~/state/entities";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import {
  CAPTURE_PASSWORD_DESCRIPTION,
  CapturePasswordField,
  CopyableCaptureValue,
  CopyValueButton,
  MAIL_SLUG_DESCRIPTION,
  MailSlugField,
} from "./EmailCaptureFields";
import {
  emailCaptureAddress,
  emailSmtpHostLabel,
  otherCapturePasswords,
  otherMailSlugs,
  withEmailProjectSettings,
} from "./emailSettings.logic";

export function EmailProjectCaptureSettings({
  settings,
  save,
}: {
  settings: EmailCaptureSettings;
  /** Sends the whole document, the way every capture write does; true when it landed. */
  save: (next: EmailCaptureSettings) => Promise<boolean>;
}) {
  const projects = useProjects();

  return (
    <SettingsSection
      {...searchableSetting("email-project-capture")}
      icon={<MailIcon className="size-3.5" />}
    >
      {settings.projects.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground sm:px-4">
          A project gets a capture address — and everything below — as soon as it exists.
        </p>
      ) : (
        <div className="divide-y divide-border/60">
          {settings.projects.map((project) => (
            <ProjectCaptureBlock
              key={project.projectId}
              project={project}
              // The slug is the fallback name: an entry can outlive the client's view of a project.
              projectName={
                projects.find((candidate) => candidate.id === project.projectId)?.title ??
                project.mailSlug
              }
              save={save}
              settings={settings}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

function ProjectCaptureBlock({
  project,
  projectName,
  settings,
  save,
}: {
  project: EmailProjectSettings;
  projectName: string;
  settings: EmailCaptureSettings;
  save: (next: EmailCaptureSettings) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);

  const captureAddress = emailCaptureAddress(project.mailSlug);
  const host = emailSmtpHostLabel(settings.listener.bindAddress);
  const patch = (values: Partial<Omit<EmailProjectSettings, "projectId">>): Promise<boolean> =>
    save(withEmailProjectSettings(settings, project.projectId, values));

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left outline-hidden ring-ring focus-visible:ring-2">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{projectName}</span>
          <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
            {captureAddress}
          </span>
        </CollapsibleTrigger>
        <CopyValueButton
          ariaLabel={`Copy the capture address for ${projectName}`}
          label="Capture address"
          value={captureAddress}
        />
      </div>

      <CollapsiblePanel>
        <div className="space-y-1 pb-2">
          <SettingsRow
            control={
              <CopyableCaptureValue
                ariaLabel={`Copy the SMTP host for ${projectName}`}
                label="SMTP host"
                value={host}
              />
            }
            description={
              settings.listener.bindAddress.trim() === "0.0.0.0"
                ? "The listener accepts on every interface, so an app on this machine uses localhost. From Docker on Linux or another machine on the network, use this machine's own address instead."
                : "The listener is bound to this address, so only what can reach it there is captured."
            }
            title="SMTP host"
          />

          <SettingsRow
            control={
              <CopyableCaptureValue
                ariaLabel={`Copy the SMTP port for ${projectName}`}
                label="SMTP port"
                value={String(settings.listener.port)}
              />
            }
            description="One port for every project — routing happens inside the SMTP session, not on the port."
            title="SMTP port"
          />

          <SettingsRow
            control={
              <CopyableCaptureValue
                ariaLabel={`Copy the SMTP username for ${projectName}`}
                label="SMTP username"
                value={project.mailSlug}
              />
            }
            description="The AUTH username is the first routing rule: an app that signs in as this lands here whatever it addresses. Any password is accepted, so the app needs no other setup."
            title="SMTP username"
          />

          <SettingsRow
            control={
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <CapturePasswordField
                  ariaLabel={`Capture password for ${projectName}`}
                  onCommit={(capturePassword) => patch({ capturePassword })}
                  takenPasswords={otherCapturePasswords(settings, project.projectId)}
                  value={project.capturePassword}
                />
                <CopyValueButton
                  ariaLabel={`Copy the capture password for ${projectName}`}
                  disabled={project.capturePassword === null}
                  label="Capture password"
                  value={project.capturePassword ?? ""}
                />
              </div>
            }
            description={CAPTURE_PASSWORD_DESCRIPTION}
            title="SMTP password"
          />

          <SettingsRow
            control={
              <MailSlugField
                ariaLabel={`Mail slug for ${projectName}`}
                onCommit={(mailSlug) => patch({ mailSlug })}
                takenSlugs={otherMailSlugs(settings, project.projectId)}
                value={project.mailSlug}
              />
            }
            description={
              <>
                {MAIL_SLUG_DESCRIPTION} Renaming it changes the username and the address to{" "}
                <span className="font-mono">{captureAddress}</span>.
              </>
            }
            title="Mail slug"
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
                  Toasts are off for every project above.
                </span>
              )
            }
            title="Toast on captured mail"
          />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
