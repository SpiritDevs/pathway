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
import type { EmailInboxScope } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BarChart3Icon, FolderIcon, InboxIcon, MailQuestionIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import {
  ALL_EMAIL_SCOPE,
  emailScopeKey,
  findEmailInbox,
  UNASSIGNED_EMAIL_SCOPE,
  useEmailInboxSummaries,
} from "../../state/email";
import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
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

function LocalSmtpInboxes() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const rawSearch = useLocation({ select: (location) => location.search });
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = parseEmailSearch(rawSearch as Record<string, unknown>);
  const onEmail = pathname === "/email";
  const projects = useProjects();

  // The same atom the list pane reads, so the badges never disagree with the rows beside them.
  const scope = emailScopeFromParam(search.inbox);
  const inboxes = useEmailInboxSummaries(scope);
  const activeKey = onEmail && search.analytics !== true ? emailScopeKey(scope) : null;

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
              return (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    isActive={activeKey === emailScopeKey(projectScope)}
                    onClick={() => selectInbox(projectScope)}
                  >
                    <FolderIcon />
                    <span className="truncate">{project.title}</span>
                    {unread > 0 ? <SidebarMenuBadge>{unread}</SidebarMenuBadge> : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })
          )}
        </SidebarMenu>
      </SidebarGroup>

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
              onClick={() => navigateWith({ analytics: true, message: undefined, tab: undefined })}
            >
              <BarChart3Icon />
              <span>Analytics</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
