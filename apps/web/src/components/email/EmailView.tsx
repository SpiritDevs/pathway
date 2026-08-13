/**
 * `/email` — the two-pane mail client for locally captured SMTP.
 *
 * Which inbox, which message, and which tab all live in the URL so the view is linkable and the
 * sidebar can drive it without owning any state (`components/issues/IssuesSidebar.tsx` navigates
 * the same way). Opening a message marks it read, which is what keeps the sidebar's unread badges
 * meaningful; the reading pane carries the way back out.
 *
 * @module components/email/EmailView
 */
import type { CapturedEmailSummary, EmailMessageId, ProjectId } from "@t3tools/contracts";
import { BarChart3Icon, MailIcon, MailOpenIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import {
  findEmailInbox,
  useEmailInbox,
  useEmailMessage,
  useMarkEmailRead,
  useMarkEmailUnread,
  type EmailStoreStatus,
} from "~/state/email";
import { Button } from "../ui/button";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { EmailMessageList } from "./EmailMessageList";
import { EmailReadingPane } from "./EmailReadingPane";
import {
  emailReadingTab,
  emailScopeFromParam,
  type EmailSearch,
  type EmailSearchPatch,
} from "./emailView.logic";

const EMAIL_MESSAGE_LIST_DEFAULT_WIDTH = 352;
const EMAIL_MESSAGE_LIST_MIN_WIDTH = 240;
const EMAIL_MESSAGE_LIST_MAX_WIDTH = 640;
const EMAIL_READING_PANE_MIN_WIDTH = 320;
const EMAIL_MESSAGE_LIST_WIDTH_STORAGE_KEY = "pathway:email-message-list-width";
const EMAIL_MESSAGE_LIST_KEYBOARD_STEP = 24;

export function EmailView({
  search,
  onSearch,
}: {
  search: EmailSearch;
  onSearch: (patch: EmailSearchPatch) => void;
}) {
  const scope = emailScopeFromParam(search.inbox);
  const inbox = useEmailInbox(scope);
  const projects = useProjects();
  const markRead = useMarkEmailRead();
  const markUnread = useMarkEmailUnread();
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const [messageListMaxWidth, setMessageListMaxWidth] = useState(EMAIL_MESSAGE_LIST_MAX_WIDTH);

  useEffect(() => {
    const splitPane = splitPaneRef.current;
    if (splitPane === null) return;

    const updateMaxWidth = () => {
      setMessageListMaxWidth(
        Math.max(
          EMAIL_MESSAGE_LIST_MIN_WIDTH,
          Math.min(
            EMAIL_MESSAGE_LIST_MAX_WIDTH,
            splitPane.clientWidth - EMAIL_READING_PANE_MIN_WIDTH,
          ),
        ),
      );
    };
    const observer = new ResizeObserver(updateMaxWidth);
    observer.observe(splitPane);
    updateMaxWidth();
    return () => observer.disconnect();
  }, []);

  const messageListWidth = useResizableWidth({
    storageKey: EMAIL_MESSAGE_LIST_WIDTH_STORAGE_KEY,
    defaultWidth: EMAIL_MESSAGE_LIST_DEFAULT_WIDTH,
    minWidth: EMAIL_MESSAGE_LIST_MIN_WIDTH,
    maxWidth: messageListMaxWidth,
    edge: "right",
  });

  const selectedId = (search.message ?? null) as EmailMessageId | null;
  const detail = useEmailMessage(selectedId);
  const tab = emailReadingTab(search);

  const projectTitles = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  // Read once rather than tracked: nothing in a message list is worth a midnight timer, and a
  // reconnect or a route change re-reads it. Same trade as the issue list's `today`.
  const now = useMemo(() => new Date(), []);

  const inboxName =
    scope.type === "all"
      ? "All mail"
      : scope.type === "unassigned"
        ? "Unassigned"
        : (projectTitles.get(scope.projectId) ?? "Project");

  // Opening is what marks a message read, so the write follows the URL rather than the click: a
  // deep link into a message counts as having opened it.
  const markOpenedRead = useEffectEvent((messageId: EmailMessageId) => {
    void markRead({ target: { type: "message", messageId } });
  });
  useEffect(() => {
    if (selectedId === null) return;
    markOpenedRead(selectedId);
  }, [selectedId]);

  const selectMessage = (message: CapturedEmailSummary) => onSearch({ message: message.id });

  const unreadCount = findEmailInbox(inbox.inboxes, scope)?.unreadCount ?? 0;

  if (search.analytics === true) {
    return (
      <EmailShell inboxName={inboxName}>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart3Icon />
            </EmptyMedia>
            <EmptyTitle>Analytics</EmptyTitle>
            <EmptyDescription>
              Volume over time, per-project counts, top senders and recipients, and capture latency
              for {inboxName}. Not wired up yet.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </EmailShell>
    );
  }

  return (
    <EmailShell inboxName={inboxName}>
      <div className="flex min-h-0 flex-1" ref={splitPaneRef}>
        <div
          className="relative flex min-w-0 shrink-0 flex-col border-e border-border/50"
          style={{ width: messageListWidth.width }}
        >
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
            <span className="truncate text-xs font-medium text-foreground">{inboxName}</span>
            <span className="text-xs tabular-nums text-muted-foreground/70">
              {inbox.messages.length} {inbox.messages.length === 1 ? "message" : "messages"}
            </span>
            {inbox.isPending ? <Spinner className="ms-auto size-3" /> : null}
            {/* Clears this inbox's badge in one write; the reading pane carries the way back. */}
            {unreadCount > 0 ? (
              <Button
                className={cn("h-6 px-2 text-xs", inbox.isPending ? null : "ms-auto")}
                onClick={() => void markRead({ target: { type: "inbox", scope } })}
                size="xs"
                variant="ghost"
              >
                <MailOpenIcon aria-hidden="true" />
                Mark all read
              </Button>
            ) : null}
          </div>

          {inbox.messages.length === 0 ? (
            <EmptyInbox error={inbox.error} isPending={inbox.isPending} status={inbox.status} />
          ) : (
            <div className="min-h-0 flex-1">
              <EmailMessageList
                messages={inbox.messages}
                now={now}
                onSelect={selectMessage}
                selectedMessageId={selectedId}
              />
            </div>
          )}

          <EmailMessageListResizeHandle
            maxWidth={messageListMaxWidth}
            onResize={messageListWidth.resizeTo}
            pointerHandlers={messageListWidth.handlers}
            width={messageListWidth.width}
          />
        </div>

        <EmailReadingPane
          error={detail.error}
          isPending={detail.isPending}
          message={detail.message}
          onMarkUnread={() => {
            if (selectedId === null) return;
            void markUnread({ target: { type: "message", messageId: selectedId } });
          }}
          onTab={(next) => onSearch({ tab: next })}
          projectName={
            detail.message === null || detail.message.attribution.projectId === null
              ? null
              : (projectTitles.get(detail.message.attribution.projectId) ?? null)
          }
          tab={tab}
        />
      </div>
    </EmailShell>
  );
}

function EmailMessageListResizeHandle({
  width,
  maxWidth,
  onResize,
  pointerHandlers,
}: {
  width: number;
  maxWidth: number;
  onResize: (width: number) => void;
  pointerHandlers: ReturnType<typeof useResizableWidth>["handlers"];
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextWidth =
      event.key === "ArrowLeft"
        ? width - EMAIL_MESSAGE_LIST_KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? width + EMAIL_MESSAGE_LIST_KEYBOARD_STEP
          : event.key === "Home"
            ? EMAIL_MESSAGE_LIST_MIN_WIDTH
            : event.key === "End"
              ? maxWidth
              : null;
    if (nextWidth === null) return;
    event.preventDefault();
    onResize(nextWidth);
  };

  return (
    <div
      aria-label="Resize message list"
      aria-orientation="vertical"
      aria-valuemax={maxWidth}
      aria-valuemin={EMAIL_MESSAGE_LIST_MIN_WIDTH}
      aria-valuenow={width}
      className="group absolute inset-y-0 -end-1 z-20 w-2 cursor-col-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onDoubleClick={() => onResize(EMAIL_MESSAGE_LIST_DEFAULT_WIDTH)}
      onKeyDown={onKeyDown}
      role="separator"
      tabIndex={0}
      title="Drag to resize the message list"
      {...pointerHandlers}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 start-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}

function EmailShell({ inboxName, children }: { inboxName: string; children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar drag-region px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Email breadcrumb">
            <WorkspaceBreadcrumbItem>Email</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>{inboxName}</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>
        {children}
      </div>
    </SidebarInset>
  );
}

/** Three ways to have no rows, and they mean different things to whoever is looking at them. */
function EmptyInbox({
  error,
  isPending,
  status,
}: {
  error: string | null;
  isPending: boolean;
  status: EmailStoreStatus;
}) {
  if (isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const title =
    status === "disconnected"
      ? "Not connected"
      : error === null
        ? "No captured mail"
        : "Capture is unavailable";
  const description =
    status === "disconnected"
      ? "Captured mail lives on the machine running the server, so there is nothing to show until this client is connected to one."
      : (error ??
        "Point a local app's SMTP host at this server and anything it sends lands here instead of a real mailbox.");

  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MailIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
