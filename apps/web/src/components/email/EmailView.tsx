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
import type { CapturedEmailSummary, EmailMessageId, ProjectId } from "@spiritdevs/contracts";
import { MailIcon, SearchXIcon } from "lucide-react";
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
import { readLocalApi } from "~/localApi";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { EmailBulkBar } from "./EmailBulkBar";
import { EmailListToolbar } from "./EmailListToolbar";
import { EmailAnalyticsPanel } from "./EmailAnalyticsPanel";
import { EmailMessageList } from "./EmailMessageList";
import { EmailReadingPane } from "./EmailReadingPane";
import { reportEmailWriteFailure } from "./emailWrites";
import {
  EMPTY_EMAIL_SELECTION,
  NO_EMAIL_LIST_FILTER,
  emailActionContextMenuItems,
  emailActionMenuItems,
  emailActionTargets,
  emailIdsNeedingReadState,
  emailSelectAllState,
  emailSelectModeForModifiers,
  filterEmailMessages,
  pruneEmailSelection,
  selectEmailRow,
  selectedEmailMessages,
  toggleEmailSelectAll,
  type EmailListFilter,
  type EmailMessageAction,
} from "./emailList.logic";
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
  // Search and filters are view state, not URL state: they narrow which rows are on screen and
  // never change which message is open, so nothing about them is worth a link or a history entry.
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState<EmailListFilter>(NO_EMAIL_LIST_FILTER);
  const [selection, setSelection] = useState(EMPTY_EMAIL_SELECTION);
  const readStateWriteInFlightRef = useRef(false);
  const [isApplyingReadState, setIsApplyingReadState] = useState(false);

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

  const inboxSummary = findEmailInbox(inbox.inboxes, scope);
  const unreadCount = inboxSummary?.unreadCount ?? 0;

  const visibleMessages = useMemo(
    () => filterEmailMessages(inbox.messages, { query, filter }),
    [filter, inbox.messages, query],
  );
  const visibleIds = useMemo(() => visibleMessages.map((message) => message.id), [visibleMessages]);

  // A capture, a retention sweep, a scope change, and a keystroke in the search field all take rows
  // away. `pruneEmailSelection` hands back the same selection when none of them moved anything, so
  // the common case settles without a re-render.
  useEffect(() => {
    setSelection((current) => pruneEmailSelection(current, visibleIds));
  }, [visibleIds]);

  const selectedMessages = selectedEmailMessages(visibleMessages, selection);
  const selectedUnreadCount = selectedMessages.filter((message) => !message.isRead).length;

  /**
   * Read state is per message on the wire, so a bulk press is one call per row that actually
   * changes — a select-all over an already-read inbox sends nothing. One toast for the batch:
   * these fail together or not at all.
   */
  const applyReadState = async (targets: ReadonlyArray<CapturedEmailSummary>, isRead: boolean) => {
    if (readStateWriteInFlightRef.current) return;
    const ids = emailIdsNeedingReadState(targets, isRead);
    if (ids.length === 0) return;
    readStateWriteInFlightRef.current = true;
    setIsApplyingReadState(true);
    const write = isRead ? markRead : markUnread;
    try {
      // Selecting the entire current inbox can use the server's one-write scope target. Subsets
      // still use the only supported per-message target, but the in-flight guard prevents a second
      // press from duplicating that serialized batch over a remote connection.
      const coversInbox =
        inboxSummary !== null &&
        inbox.messages.length === inboxSummary.messageCount &&
        targets.length === inbox.messages.length &&
        inbox.messages.every((message) => targets.some((target) => target.id === message.id));
      const results = coversInbox
        ? [await write({ target: { type: "inbox", scope } })]
        : await Promise.all(
            ids.map((messageId) => write({ target: { type: "message", messageId } })),
          );
      const failure = results.find((result) => result._tag === "Failure");
      if (failure !== undefined) {
        reportEmailWriteFailure(
          isRead ? "Couldn't mark as read" : "Couldn't mark as unread",
          failure,
        );
      }
    } finally {
      readStateWriteInFlightRef.current = false;
      setIsApplyingReadState(false);
    }
  };

  const runAction = (
    action: EmailMessageAction,
    targets: ReadonlyArray<CapturedEmailSummary>,
    message: CapturedEmailSummary | null,
  ) => {
    if (action === "open") {
      if (message !== null) selectMessage(message);
      return;
    }
    if (action === "mark-read") {
      void applyReadState(targets, true);
      return;
    }
    if (action === "mark-unread") void applyReadState(targets, false);
    // `add-tag` and `delete` are listed disabled on every surface, so nothing can dispatch them.
  };

  /**
   * The right-click menu, through the local API so the desktop shell draws a native menu and the
   * browser gets the DOM fallback. It offers exactly what the row's three-dot menu does, against
   * the same rows — a right-click on an unchecked row acts on that row alone and leaves the
   * selection untouched.
   */
  const showRowContextMenu = async (
    message: CapturedEmailSummary,
    position: { readonly x: number; readonly y: number },
  ) => {
    const api = readLocalApi();
    if (api === undefined) return;
    const targets = emailActionTargets(visibleMessages, selection, message);
    const items = emailActionMenuItems({
      count: targets.length,
      unreadCount: targets.filter((target) => !target.isRead).length,
      includeOpen: true,
    });
    const clicked = await api.contextMenu.show(emailActionContextMenuItems(items), position);
    if (clicked === null) return;
    runAction(clicked, targets, message);
  };

  // Analytics is a lens on the selected inbox rather than a route of its own, so it takes the same
  // scope the mailbox below it would have shown.
  if (search.analytics === true) {
    return (
      <EmailShell inboxName={inboxName}>
        <EmailAnalyticsPanel inboxName={inboxName} projectTitles={projectTitles} scope={scope} />
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
          <EmailListToolbar
            filter={filter}
            inboxName={inboxName}
            isPending={inbox.isPending}
            onFilter={setFilter}
            /* Clears this inbox's badge in one write; the reading pane carries the way back. */
            onMarkAllRead={() => void markRead({ target: { type: "inbox", scope } })}
            onQuery={setQuery}
            onSearchOpen={setSearchOpen}
            onToggleSelectAll={() =>
              setSelection((current) => toggleEmailSelectAll(current, visibleIds))
            }
            query={query}
            searchOpen={searchOpen}
            selectAllState={emailSelectAllState(selection, visibleIds)}
            totalCount={inbox.messages.length}
            unreadCount={unreadCount}
            visibleCount={visibleMessages.length}
          />

          {selectedMessages.length === 0 ? null : (
            <EmailBulkBar
              disabled={isApplyingReadState}
              messages={selectedMessages}
              onAction={(action) => runAction(action, selectedMessages, null)}
              onClear={() => setSelection(EMPTY_EMAIL_SELECTION)}
            />
          )}

          {inbox.messages.length === 0 ? (
            <EmptyInbox error={inbox.error} isPending={inbox.isPending} status={inbox.status} />
          ) : visibleMessages.length === 0 ? (
            <NoMatchingMail
              onClear={() => {
                setQuery("");
                setSearchOpen(false);
                setFilter(NO_EMAIL_LIST_FILTER);
              }}
            />
          ) : (
            <div className="min-h-0 flex-1">
              <EmailMessageList
                messages={visibleMessages}
                now={now}
                onAction={(message, action) =>
                  runAction(
                    action,
                    emailActionTargets(visibleMessages, selection, message),
                    message,
                  )
                }
                onContextMenu={(message, position) => void showRowContextMenu(message, position)}
                onSelect={selectMessage}
                onToggleSelect={(message, modifiers) =>
                  setSelection((current) =>
                    selectEmailRow(current, {
                      ids: visibleIds,
                      messageId: message.id,
                      mode: emailSelectModeForModifiers(modifiers),
                    }),
                  )
                }
                selectedMessageId={selectedId}
                selection={{
                  ids: selection.ids,
                  count: selectedMessages.length,
                  unreadCount: selectedUnreadCount,
                }}
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

/**
 * The fourth way to have no rows, and the only one the reader caused. It carries the way back out,
 * because a search that hides every message and offers nothing but a cleared field is a dead end.
 */
function NoMatchingMail({ onClear }: { onClear: () => void }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>No matching mail</EmptyTitle>
        <EmptyDescription>
          Every message in this inbox is hidden by the current search or filters.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onClear} size="sm" variant="outline">
          Clear search and filters
        </Button>
      </EmptyContent>
    </Empty>
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
