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
import type { EmailMessageId, EmailTagId, EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { useAtomValue } from "@effect/atom-react";
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
import { useCapturedEmailAdmin } from "~/cloud/capturedEmailAdmin";
import {
  cloudTrustedEmailSendersAtom,
  trustedEmailSenderAddressesForCompany,
} from "~/cloud/capturedEmailReadModel";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import {
  useEmailInbox,
  useEmailMessage,
  useEmailTags,
  useDeleteEmailMessages,
  useMarkEmailRead,
  useMarkEmailUnread,
  type EmailStoreStatus,
  type CapturedEmailListItem,
} from "~/state/email";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { stackedThreadToast, toastManager } from "../ui/toast";
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
import { EmailTagDialog } from "./EmailTagDialog";
import { useIssueProjectOptions } from "../issues/useIssueProjectOptions";
import { buildEmailSidebarProjects, findEmailSidebarProject } from "./emailSidebar.logic";
import { reportEmailWriteFailure } from "./emailWrites";
import {
  EMPTY_EMAIL_SELECTION,
  NO_EMAIL_LIST_FILTER,
  emailActionContextMenuItems,
  emailActionMenuItems,
  emailActionTargets,
  emailIdsNeedingReadState,
  emailMessageSelectionId,
  emailSelectAllState,
  emailSelectModeForModifiers,
  filterEmailMessages,
  pruneEmailActionTargets,
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

async function forEachWithConcurrency<A>(
  values: ReadonlyArray<A>,
  concurrency: number,
  run: (value: A) => Promise<void>,
) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const value = values[index++];
        if (value !== undefined) await run(value);
      }
    }),
  );
}

function reportCloudEmailFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

export function EmailView({
  search,
  onSearch,
}: {
  search: EmailSearch;
  onSearch: (patch: EmailSearchPatch) => void;
}) {
  const scope = useMemo(() => emailScopeFromParam(search.inbox), [search.inbox]);
  const environmentFilter = (search.environment ?? null) as EnvironmentId | null;
  const projects = useProjects();
  const projectOptions = useIssueProjectOptions();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const emailProjects = useMemo(
    () => buildEmailSidebarProjects(projectOptions, primaryEnvironmentId),
    [primaryEnvironmentId, projectOptions],
  );
  const selectedProject =
    scope.type === "project" ? findEmailSidebarProject(emailProjects, scope.projectId) : null;
  const inbox = useEmailInbox(scope, environmentFilter, selectedProject?.connections);
  const { environments } = useEnvironments();
  const markRead = useMarkEmailRead();
  const markUnread = useMarkEmailUnread();
  const deleteLocalMessages = useDeleteEmailMessages();
  const tags = useEmailTags();
  const emailAdmin = useCapturedEmailAdmin();
  const trustedSenders = useAtomValue(cloudTrustedEmailSendersAtom);
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
  const [tagTargets, setTagTargets] = useState<ReadonlyArray<CapturedEmailListItem>>([]);
  const [deleteTargets, setDeleteTargets] = useState<ReadonlyArray<CapturedEmailListItem>>([]);
  const [isApplyingAction, setIsApplyingAction] = useState(false);

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

  const selectedKey = search.message ?? null;
  const selectedListMessage =
    selectedKey === null
      ? null
      : (inbox.messages.find((message) => emailMessageSelectionId(message) === selectedKey) ??
        inbox.messages.find((message) => message.id === selectedKey) ??
        null);
  const selectedId =
    selectedListMessage?.id ??
    (selectedKey !== null && !selectedKey.includes("\0") ? (selectedKey as EmailMessageId) : null);
  const detail = useEmailMessage(
    selectedId,
    selectedListMessage === null
      ? undefined
      : {
          companyId: selectedListMessage.companyId,
          environmentId: selectedListMessage.environmentId,
        },
  );
  const tab = emailReadingTab(search);

  const projectTitles = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const environmentTitles = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const trustedSenderAddresses = useMemo(
    () =>
      trustedEmailSenderAddressesForCompany(trustedSenders, selectedListMessage?.companyId ?? null),
    [selectedListMessage?.companyId, trustedSenders],
  );
  // Read once rather than tracked: nothing in a message list is worth a midnight timer, and a
  // reconnect or a route change re-reads it. Same trade as the issue list's `today`.
  const now = useMemo(() => new Date(), []);

  const inboxName =
    scope.type === "all"
      ? "All mail"
      : scope.type === "unassigned"
        ? "Unassigned"
        : (selectedProject?.title ?? projectTitles.get(scope.projectId) ?? "Project");

  // Opening is what marks a message read, so the write follows the URL rather than the click: a
  // deep link into a message counts as having opened it.
  const markOpenedRead = useEffectEvent(
    (messageId: EmailMessageId, environmentId: EnvironmentId) => {
      void markRead({ environmentId, target: { type: "message", messageId } });
    },
  );
  const selectedEnvironmentId = selectedListMessage?.environmentId ?? detail.environmentId;
  useEffect(() => {
    if (selectedId === null || selectedEnvironmentId === null) return;
    markOpenedRead(selectedId, selectedEnvironmentId);
  }, [selectedEnvironmentId, selectedId]);

  const selectMessage = (message: CapturedEmailListItem) =>
    onSearch({ message: emailMessageSelectionId(message) });

  const unreadCount = inbox.messages.filter((message) => !message.isRead).length;

  const visibleMessages = useMemo(() => {
    const filtered = filterEmailMessages(inbox.messages, { query, filter });
    return search.tag === undefined
      ? filtered
      : filtered.filter((message) => message.tagIds.includes(search.tag as EmailTagId));
  }, [filter, inbox.messages, query, search.tag]);
  const visibleIds = useMemo(() => visibleMessages.map(emailMessageSelectionId), [visibleMessages]);

  // A capture, a retention sweep, a scope change, and a keystroke in the search field all take rows
  // away. `pruneEmailSelection` hands back the same selection when none of them moved anything, so
  // the common case settles without a re-render.
  useEffect(() => {
    setSelection((current) => pruneEmailSelection(current, visibleIds));
  }, [visibleIds]);

  const selectedMessages = selectedEmailMessages(visibleMessages, selection);
  const selectedUnreadCount = selectedMessages.filter((message) => !message.isRead).length;
  const currentTagTargets = tagTargets.map((target) =>
    inbox.messages.find(
      (message) =>
        message.companyId === target.companyId &&
        message.id === target.id &&
        message.environmentId === target.environmentId,
    ),
  );
  const resolvedTagTargets = currentTagTargets.filter(
    (target): target is CapturedEmailListItem => target !== undefined,
  );
  const currentDeleteTargets = deleteTargets.flatMap((target) => {
    const current = inbox.messages.find(
      (message) => emailMessageSelectionId(message) === emailMessageSelectionId(target),
    );
    return current === undefined ? [] : [current];
  });
  useEffect(() => {
    setTagTargets((current) => pruneEmailActionTargets(current, inbox.messages));
    setDeleteTargets((current) => pruneEmailActionTargets(current, inbox.messages));
  }, [inbox.messages]);
  const tagTargetCompanyId = resolvedTagTargets[0]?.companyId ?? null;
  const availableTags = useMemo(
    () =>
      tagTargetCompanyId === null ? [] : tags.filter((tag) => tag.companyId === tagTargetCompanyId),
    [tagTargetCompanyId, tags],
  );

  /**
   * A selected subset writes only rows that change. Mark-all groups the same logical inbox by
   * source environment, translating a shared project back to that environment's local project id,
   * so a full mailbox stays one write per source rather than one write per message.
   */
  const applyReadState = async (
    targets: ReadonlyArray<CapturedEmailListItem>,
    isRead: boolean,
    coversInbox = false,
  ) => {
    if (readStateWriteInFlightRef.current) return;
    const ids = new Set(emailIdsNeedingReadState(targets, isRead));
    const changed = targets.filter((message) => ids.has(message.id));
    if (changed.length === 0) return;
    readStateWriteInFlightRef.current = true;
    setIsApplyingReadState(true);
    const write = isRead ? markRead : markUnread;
    try {
      const writes = [];
      const individually = new Set(changed);
      if (coversInbox) {
        const byEnvironment = new Map<EnvironmentId, CapturedEmailListItem[]>();
        for (const message of changed) {
          const group = byEnvironment.get(message.environmentId) ?? [];
          group.push(message);
          byEnvironment.set(message.environmentId, group);
        }
        for (const [environmentId, messages] of byEnvironment) {
          const sourceProjectIds = new Set(
            messages.map((message) => message.attribution.projectId).filter((id) => id !== null),
          );
          const sourceScope =
            scope.type !== "project"
              ? scope
              : sourceProjectIds.size === 1
                ? { type: "project" as const, projectId: [...sourceProjectIds][0]! }
                : null;
          if (sourceScope === null) continue;
          writes.push(write({ environmentId, target: { type: "inbox", scope: sourceScope } }));
          for (const message of messages) individually.delete(message);
        }
      }
      writes.push(
        ...[...individually].map((message) =>
          write({
            environmentId: message.environmentId,
            target: { type: "message", messageId: message.id },
          }),
        ),
      );
      const results = await Promise.all(writes);
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

  const applyTag = async (tagId: EmailTagId, present: boolean) => {
    if (
      emailAdmin === null ||
      tagTargetCompanyId === null ||
      resolvedTagTargets.length === 0 ||
      isApplyingAction
    )
      return;
    if (!availableTags.some((tag) => tag.id === tagId)) return;
    setIsApplyingAction(true);
    try {
      await forEachWithConcurrency(resolvedTagTargets, 4, (message) =>
        emailAdmin.setTag(
          tagTargetCompanyId,
          { environmentId: message.environmentId, messageId: message.id },
          tagId,
          present,
        ),
      );
    } catch (error) {
      reportCloudEmailFailure("Couldn't update email tags", error);
    } finally {
      setIsApplyingAction(false);
    }
  };

  const createAndApplyTag = async (input: { name: string; color: string }) => {
    if (emailAdmin === null || tagTargetCompanyId === null || isApplyingAction) return;
    setIsApplyingAction(true);
    try {
      const tagId = await emailAdmin.createTag({ companyId: tagTargetCompanyId, ...input });
      await forEachWithConcurrency(resolvedTagTargets, 4, (message) =>
        emailAdmin.setTag(
          tagTargetCompanyId,
          { environmentId: message.environmentId, messageId: message.id },
          tagId,
          true,
        ),
      );
    } catch (error) {
      reportCloudEmailFailure("Couldn't create the email tag", error);
    } finally {
      setIsApplyingAction(false);
    }
  };

  const deleteMessages = async () => {
    if (currentDeleteTargets.length === 0 || isApplyingAction) return;
    const targets = currentDeleteTargets;
    setIsApplyingAction(true);
    try {
      // Cloud first makes the delete durable while a source is offline. The source RPC then removes
      // SQLite, raw source, and attachment files immediately wherever that environment is online.
      if (emailAdmin !== null) {
        const byCompany = new Map<
          NonNullable<CapturedEmailListItem["companyId"]>,
          CapturedEmailListItem[]
        >();
        for (const message of targets) {
          if (message.companyId === null) continue;
          const messages = byCompany.get(message.companyId) ?? [];
          messages.push(message);
          byCompany.set(message.companyId, messages);
        }
        for (const [companyId, messages] of byCompany) {
          for (let index = 0; index < messages.length; index += 100) {
            await emailAdmin.deleteMessages(
              companyId,
              messages.slice(index, index + 100).map((message) => ({
                environmentId: message.environmentId,
                messageId: message.id,
              })),
            );
          }
        }
      }
      const byEnvironment = new Map<EnvironmentId, EmailMessageId[]>();
      for (const message of targets) {
        const ids = byEnvironment.get(message.environmentId) ?? [];
        ids.push(message.id);
        byEnvironment.set(message.environmentId, ids);
      }
      for (const [environmentId, ids] of byEnvironment) {
        for (let index = 0; index < ids.length; index += 100) {
          const result = await deleteLocalMessages({
            environmentId,
            messageIds: ids.slice(index, index + 100),
          });
          if (result._tag === "Failure") {
            reportEmailWriteFailure("Couldn't delete captured mail from its source", result);
          }
        }
      }
      if (
        selectedKey !== null &&
        targets.some((message) => emailMessageSelectionId(message) === selectedKey)
      ) {
        onSearch({ message: undefined, tab: undefined });
      }
      setSelection(EMPTY_EMAIL_SELECTION);
      setDeleteTargets([]);
    } catch (error) {
      reportCloudEmailFailure("Couldn't delete captured mail", error);
    } finally {
      setIsApplyingAction(false);
    }
  };

  const runAction = (
    action: EmailMessageAction,
    targets: ReadonlyArray<CapturedEmailListItem>,
    message: CapturedEmailListItem | null,
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
    if (action === "add-tag") {
      if (emailAdmin === null) {
        reportCloudEmailFailure(
          "Tags require company sync",
          new Error("Connect and sign in to the synced company before tagging captured mail."),
        );
        return;
      }
      const companyIds = new Set(targets.map((target) => target.companyId));
      if (companyIds.size !== 1 || companyIds.has(null)) {
        reportCloudEmailFailure(
          "Choose mail from one company",
          new Error("Email tags belong to one company. Select messages from a single company."),
        );
        return;
      }
      setTagTargets(targets);
    }
    if (action === "delete") setDeleteTargets(targets);
  };

  /**
   * The right-click menu, through the local API so the desktop shell draws a native menu and the
   * browser gets the DOM fallback. It offers exactly what the row's three-dot menu does, against
   * the same rows — a right-click on an unchecked row acts on that row alone and leaves the
   * selection untouched.
   */
  const showRowContextMenu = async (
    message: CapturedEmailListItem,
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
            /* Routes each unread row to the environment that captured it. */
            onMarkAllRead={() => void applyReadState(inbox.messages, true, true)}
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
                onSearch({ tag: undefined, message: undefined });
              }}
            />
          ) : (
            <div className="min-h-0 flex-1">
              <EmailMessageList
                environmentNames={environmentTitles}
                messages={visibleMessages}
                tags={tags}
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
                      messageId: emailMessageSelectionId(message),
                      mode: emailSelectModeForModifiers(modifiers),
                    }),
                  )
                }
                selectedMessageId={selectedKey}
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
          messageIdentity={
            selectedListMessage === null ? null : emailMessageSelectionId(selectedListMessage)
          }
          tags={
            selectedListMessage?.companyId === null || selectedListMessage === null
              ? []
              : tags.filter((tag) => tag.companyId === selectedListMessage.companyId)
          }
          tagIds={detail.tagIds}
          onEditTags={() => {
            if (selectedListMessage !== null)
              runAction("add-tag", [selectedListMessage], selectedListMessage);
          }}
          onMarkUnread={() => {
            if (selectedId === null || detail.environmentId === null) return;
            void markUnread({
              environmentId: detail.environmentId,
              target: { type: "message", messageId: selectedId },
            });
          }}
          trustedSenderAddresses={trustedSenderAddresses}
          onTrustRemoteSender={(address) => {
            const companyId = selectedListMessage?.companyId ?? null;
            if (emailAdmin === null || companyId === null) {
              reportCloudEmailFailure(
                "Couldn't remember this sender",
                new Error("Connect and sign in to company sync to trust this sender everywhere."),
              );
              return;
            }
            void emailAdmin
              .trustSender(companyId, address)
              .catch((error) => reportCloudEmailFailure("Couldn't remember this sender", error));
          }}
          onTab={(next) => onSearch({ tab: next })}
          projectName={
            detail.message === null || detail.message.attribution.projectId === null
              ? null
              : detail.environmentId === primaryEnvironmentId
                ? (projectTitles.get(detail.message.attribution.projectId) ?? null)
                : scope.type === "project"
                  ? inboxName
                  : detail.message.attribution.mailSlug
          }
          environmentName={
            detail.environmentId === null
              ? null
              : (environmentTitles.get(detail.environmentId) ?? detail.environmentId)
          }
          tab={tab}
        />
      </div>
      <EmailTagDialog
        busy={isApplyingAction}
        onCreate={(input) => void createAndApplyTag(input)}
        onOpenChange={(open) => {
          if (!open) setTagTargets([]);
        }}
        onSetTag={(tagId, present) => void applyTag(tagId, present)}
        open={resolvedTagTargets.length > 0}
        tags={availableTags}
        targets={resolvedTagTargets}
      />
      <AlertDialog
        open={currentDeleteTargets.length > 0}
        onOpenChange={(open) => {
          if (!open && !isApplyingAction) setDeleteTargets([]);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete{" "}
              {currentDeleteTargets.length === 1
                ? "this message"
                : `${currentDeleteTargets.length} messages`}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the captured email, raw source, and attachments from its source
              environment and every synced view. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isApplyingAction}
              render={<Button disabled={isApplyingAction} variant="outline" />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              disabled={isApplyingAction}
              onClick={() => void deleteMessages()}
              variant="destructive"
            >
              {isApplyingAction ? <Spinner className="size-3.5" /> : null}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
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
