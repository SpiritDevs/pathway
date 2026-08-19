/**
 * The `/email` secondary sidebar: the source toggle, then the inbox list.
 *
 * Navigation is search-param state, not routes — every row writes the same `/email` params the
 * view reads, the way `IssuesSidebar` drives the issue list. Selecting an inbox drops the open
 * message: a message id belongs to exactly one inbox, so carrying it across would leave the
 * reading pane on something the list beside it no longer shows.
 *
 * The Gmail side keeps its placeholder; direct mailbox integration is separate work.
 *
 * @module components/email/EmailSidebar
 */
import type { EmailInboxScope, EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  BarChart3Icon,
  BellIcon,
  BellOffIcon,
  FolderIcon,
  InboxIcon,
  MailQuestionIcon,
  MonitorIcon,
  SettingsIcon,
  TagsIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  ALL_EMAIL_SCOPE,
  emailScopeKey,
  findEmailInbox,
  UNASSIGNED_EMAIL_SCOPE,
  useEmailInboxSummaries,
  useEmailSettings,
  useEmailTags,
  useUpdateEmailSettings,
} from "../../state/email";
import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findEmailProjectSettings, withEmailProjectSettings } from "./emailSettings.logic";
import { reportEmailWriteFailure } from "./emailWrites";
import {
  emailScopeFromParam,
  emailScopeParam,
  parseEmailSearch,
  type EmailSearchPatch,
} from "./emailView.logic";

type EmailSource = "local-smtp" | "gmail";

export function EmailSourceToggle({
  source,
  onSource,
}: {
  source: EmailSource;
  onSource: (source: EmailSource) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Email source"
      className="relative grid w-full grid-cols-2 gap-0 rounded-full border border-sidebar-foreground/15 bg-sidebar-foreground/10 p-0.5"
      size="sm"
      value={[source]}
      variant="default"
      onValueChange={(next) => {
        const nextSource = next[0];
        if (nextSource === "local-smtp" || nextSource === "gmail") onSource(nextSource);
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full bg-white shadow-sm/10 transition-transform duration-200 ease-out motion-reduce:transition-none",
          source === "gmail" && "translate-x-full",
        )}
      />
      <Toggle
        className="relative z-10 h-6 min-w-0 w-full rounded-full px-2 text-xs text-sidebar-muted-foreground shadow-none before:hidden transition-colors hover:bg-transparent hover:text-sidebar-foreground data-pressed:bg-transparent data-pressed:text-zinc-950"
        value="local-smtp"
      >
        Local SMTP
      </Toggle>
      <Toggle
        className="relative z-10 h-6 min-w-0 w-full rounded-full px-2 text-xs text-sidebar-muted-foreground shadow-none before:hidden transition-colors hover:bg-transparent hover:text-sidebar-foreground data-pressed:bg-transparent data-pressed:text-zinc-950"
        value="gmail"
      >
        Gmail
      </Toggle>
    </ToggleGroup>
  );
}

export function EmailSidebar() {
  const [source, setSource] = useState<EmailSource>("local-smtp");

  return (
    <>
      <ContextualSidebarHeader title="Email" />
      <SidebarContent>
        <SidebarGroup className="p-[var(--sidebar-content-inset)]">
          <EmailSourceToggle onSource={setSource} source={source} />
        </SidebarGroup>
        {source === "local-smtp" ? <LocalSmtpInboxes /> : <GmailPlaceholder />}
      </SidebarContent>
    </>
  );
}

function GmailPlaceholder() {
  return (
    <SidebarGroup>
      <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground/70">
        Connecting a Gmail mailbox is not available yet.
      </p>
    </SidebarGroup>
  );
}

/**
 * The bell on a project row.
 *
 * A mute stays visible; an unmuted project only shows the control on hover, so a quiet sidebar does
 * not grow a column of bells. A project whose capture entry has not arrived yet keeps the control
 * visible but inert, with a tooltip saying why — a bell that silently does nothing reads as a bug.
 */
function ProjectMuteAction({
  projectTitle,
  muted,
  pending,
  onToggle,
}: {
  projectTitle: string;
  muted: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  const action = (
    <SidebarMenuAction
      aria-disabled={pending || undefined}
      aria-label={
        pending
          ? `Capture toasts for ${projectTitle} are not ready yet`
          : muted
            ? `Unmute capture toasts for ${projectTitle}`
            : `Mute capture toasts for ${projectTitle}`
      }
      aria-pressed={pending ? undefined : muted}
      className={cn(muted && "text-sidebar-muted-foreground", pending && "opacity-50")}
      onClick={pending ? undefined : onToggle}
      showOnHover={!muted && !pending}
    >
      {muted ? <BellOffIcon /> : <BellIcon />}
    </SidebarMenuAction>
  );

  if (!pending) return action;

  return (
    <Tooltip>
      <TooltipTrigger render={action} />
      <TooltipPopup side="right">
        This project has no capture inbox yet. It appears the next time the server reads its capture
        settings.
      </TooltipPopup>
    </Tooltip>
  );
}

function LocalSmtpInboxes() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const rawSearch = useLocation({ select: (location) => location.search });
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = parseEmailSearch(rawSearch as Record<string, unknown>);
  const onEmail = pathname === "/email";
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { settings } = useEmailSettings();
  const updateSettings = useUpdateEmailSettings();
  const tags = useEmailTags();

  // The same atom the list pane reads, so the badges never disagree with the rows beside them.
  const scope = useMemo(() => emailScopeFromParam(search.inbox), [search.inbox]);
  const inboxes = useEmailInboxSummaries(
    scope,
    (search.environment ?? null) as EnvironmentId | null,
  );
  const activeKey = onEmail && search.analytics !== true ? emailScopeKey(scope) : null;

  const toggleProjectMute = async (projectId: ProjectId) => {
    // A project the server has not derived an entry for yet has nothing to mute; the entry appears
    // on the next settings read.
    const project = findEmailProjectSettings(settings, projectId);
    if (settings === null || project === null) return;
    const result = await updateSettings({
      settings: withEmailProjectSettings(settings, projectId, { toastMuted: !project.toastMuted }),
    });
    reportEmailWriteFailure("Could not change capture toasts", result);
  };

  const toggleToastMaster = async () => {
    if (settings === null) return;
    const result = await updateSettings({
      settings: { ...settings, toastsEnabled: !settings.toastsEnabled },
    });
    reportEmailWriteFailure("Could not change capture toasts", result);
  };

  const navigateWith = (patch: EmailSearchPatch) => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/email", replace: true, search: { ...search, ...patch } });
  };

  // A row lands on an inbox and nothing else: the message and the tab belong to whatever was open
  // in the inbox being left.
  const selectInbox = (target: EmailInboxScope) =>
    navigateWith({
      inbox: emailScopeParam(target),
      message: undefined,
      tab: undefined,
      analytics: undefined,
    });

  const unreadFor = (target: EmailInboxScope) => findEmailInbox(inboxes, target)?.unreadCount ?? 0;

  const unassignedUnread = unreadFor(UNASSIGNED_EMAIL_SCOPE);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Environments</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={onEmail && search.environment === undefined && search.analytics !== true}
              onClick={() =>
                navigateWith({
                  environment: undefined,
                  message: undefined,
                  analytics: undefined,
                  tab: undefined,
                })
              }
            >
              <MonitorIcon />
              <span>All environments</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {environments.map((environment) => (
            <SidebarMenuItem key={environment.environmentId}>
              <SidebarMenuButton
                isActive={
                  onEmail &&
                  search.environment === environment.environmentId &&
                  search.analytics !== true
                }
                onClick={() =>
                  navigateWith({
                    environment: environment.environmentId,
                    message: undefined,
                    analytics: undefined,
                    tab: undefined,
                  })
                }
              >
                <MonitorIcon />
                <span className="truncate">{environment.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={activeKey === emailScopeKey(ALL_EMAIL_SCOPE)}
              onClick={() => selectInbox(ALL_EMAIL_SCOPE)}
            >
              <InboxIcon />
              <span>All mail</span>
              {unreadFor(ALL_EMAIL_SCOPE) > 0 ? (
                <SidebarMenuBadge>{unreadFor(ALL_EMAIL_SCOPE)}</SidebarMenuBadge>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarMenu>
          {projects.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground/70">No projects yet.</p>
          ) : (
            projects.map((project) => {
              const projectScope: EmailInboxScope = { type: "project", projectId: project.id };
              const unread = unreadFor(projectScope);
              const projectSettings = findEmailProjectSettings(settings, project.id);
              // The settings document is the authority on a mute — it is what the toast host reads
              // — with the inbox summary answering until the first settings read lands.
              const muted =
                projectSettings?.toastMuted ??
                findEmailInbox(inboxes, projectScope)?.toastMuted ??
                false;
              return (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    isActive={activeKey === emailScopeKey(projectScope)}
                    onClick={() => selectInbox(projectScope)}
                  >
                    <FolderIcon />
                    <span className="truncate">{project.title}</span>
                    {/* Shifted left of the mute control, which owns the right edge of the row. */}
                    {unread > 0 ? (
                      <SidebarMenuBadge className="right-7">{unread}</SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuButton>
                  <ProjectMuteAction
                    muted={muted}
                    onToggle={() => void toggleProjectMute(project.id)}
                    projectTitle={project.title}
                    // A mute is a write to this project's entry, so there is nothing to write until
                    // the server has derived one. Saying so beats swallowing the click.
                    pending={settings === null || projectSettings === null}
                  />
                </SidebarMenuItem>
              );
            })
          )}
        </SidebarMenu>
      </SidebarGroup>

      {tags.length === 0 ? null : (
        <SidebarGroup>
          <SidebarGroupLabel>Tags</SidebarGroupLabel>
          <SidebarMenu>
            {tags.map((tag) => (
              <SidebarMenuItem key={tag.id}>
                <SidebarMenuButton
                  isActive={onEmail && search.tag === tag.id && search.analytics !== true}
                  onClick={() =>
                    navigateWith({
                      tag: search.tag === tag.id ? undefined : tag.id,
                      message: undefined,
                      analytics: undefined,
                    })
                  }
                >
                  <TagsIcon style={{ color: tag.color }} />
                  <span className="truncate">{tag.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}

      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={activeKey === emailScopeKey(UNASSIGNED_EMAIL_SCOPE)}
              onClick={() => selectInbox(UNASSIGNED_EMAIL_SCOPE)}
            >
              <MailQuestionIcon />
              <span>Unassigned</span>
              {unassignedUnread > 0 ? (
                <SidebarMenuBadge>{unassignedUnread}</SidebarMenuBadge>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* Analytics keeps the selected inbox rather than resetting it, which is what makes it a
              lens on the scope above instead of a second top-level view. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={onEmail && search.analytics === true}
              onClick={() =>
                navigateWith({
                  analytics: true,
                  environment: undefined,
                  message: undefined,
                  tab: undefined,
                })
              }
            >
              <BarChart3Icon />
              <span>Analytics</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup className="mt-auto">
        <SidebarMenu>
          {/* The master switch sits beside the per-project mutes it overrides, rather than only in
              Settings, because muting everything is the thing you reach for mid-flood. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-pressed={settings?.toastsEnabled ?? true}
              disabled={settings === null}
              onClick={() => void toggleToastMaster()}
            >
              {settings?.toastsEnabled === false ? <BellOffIcon /> : <BellIcon />}
              <span>Capture toasts</span>
              <span className="ms-auto text-xs text-sidebar-muted-foreground">
                {settings?.toastsEnabled === false ? "Off" : "On"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void navigate({ to: "/settings/email" });
              }}
            >
              <SettingsIcon />
              <span>Capture settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
