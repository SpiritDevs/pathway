/**
 * Everything the message list decides without touching the DOM: search, quick filters, multiple
 * selection, and the one action list both the row menu and the right-click menu are built from.
 *
 * Search and filters run on the client over the page `email.list` already handed the view, rather
 * than as request params: it is one pass over an array the component is holding anyway, and it
 * keeps a keystroke from costing a round trip and blanking the rows under the reading pane.
 *
 * @module components/email/emailList.logic
 */
import type {
  CapturedEmailSummary,
  ContextMenuItem,
  EmailAddress,
  EmailMessageId,
} from "@spiritdevs/contracts";

// ── Search ─────────────────────────────────────────────────────────────

function addressText(addresses: ReadonlyArray<EmailAddress>): string {
  return addresses.map((address) => `${address.name ?? ""} ${address.address}`).join(" ");
}

/**
 * Everything one row shows, lowercased into a single string: sender, recipients, subject, preview,
 * and the detected code. The row is what the search is filtering, so the row is what it reads.
 */
export function emailSearchHaystack(message: CapturedEmailSummary): string {
  return [
    addressText(message.from),
    addressText(message.to),
    message.subject ?? "",
    message.textPreview,
    message.detectedCode ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/** Whitespace-separated terms, all of which must match — `stripe invoice` is an AND, not a phrase. */
export function emailQueryTerms(query: string): ReadonlyArray<string> {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

export function emailMatchesQuery(message: CapturedEmailSummary, query: string): boolean {
  return matchesTerms(message, emailQueryTerms(query));
}

function matchesTerms(message: CapturedEmailSummary, terms: ReadonlyArray<string>): boolean {
  if (terms.length === 0) return true;
  const haystack = emailSearchHaystack(message);
  return terms.every((term) => haystack.includes(term));
}

// ── Quick filters ──────────────────────────────────────────────────────

export const EMAIL_FILTER_FIELDS = ["read", "attachment", "code"] as const;
export type EmailFilterField = (typeof EMAIL_FILTER_FIELDS)[number];

export type EmailReadFilterValue = "unread" | "read";
/** Both halves of "has X", so every filter added here has a way back out of it. */
export type EmailPresenceFilterValue = "has" | "none";
export type EmailFilterValue = EmailReadFilterValue | EmailPresenceFilterValue;

/**
 * OR inside a field, AND across them — the issue tracker's filter model
 * (`components/issues/issuesList.logic.ts`), with three fields instead of eight. An empty field is
 * off rather than "matches nothing", so selecting every value reads the same as selecting none.
 */
export interface EmailListFilter {
  readonly read: ReadonlyArray<EmailReadFilterValue>;
  readonly attachment: ReadonlyArray<EmailPresenceFilterValue>;
  readonly code: ReadonlyArray<EmailPresenceFilterValue>;
}

export const NO_EMAIL_LIST_FILTER: EmailListFilter = Object.freeze({
  read: Object.freeze([]),
  attachment: Object.freeze([]),
  code: Object.freeze([]),
});

export const EMAIL_FILTER_FIELD_LABELS: Readonly<Record<EmailFilterField, string>> = {
  read: "Status",
  attachment: "Attachment",
  code: "Code",
};

export const EMAIL_FILTER_FIELD_VALUES: Readonly<
  Record<EmailFilterField, ReadonlyArray<EmailFilterValue>>
> = {
  read: ["unread", "read"],
  attachment: ["has", "none"],
  code: ["has", "none"],
};

export const EMAIL_FILTER_VALUE_LABELS: Readonly<
  Record<EmailFilterField, Readonly<Record<string, string>>>
> = {
  read: { unread: "Unread", read: "Read" },
  attachment: { has: "Has attachment", none: "No attachment" },
  code: { has: "Has detected code", none: "No detected code" },
};

export function emailFilterValueLabel(field: EmailFilterField, value: EmailFilterValue): string {
  return EMAIL_FILTER_VALUE_LABELS[field][value] ?? value;
}

export function emailFilterValues(
  filter: EmailListFilter,
  field: EmailFilterField,
): ReadonlyArray<EmailFilterValue> {
  return filter[field];
}

export function withEmailFilterValues(
  filter: EmailListFilter,
  field: EmailFilterField,
  values: ReadonlyArray<EmailFilterValue>,
): EmailListFilter {
  return { ...filter, [field]: values } as EmailListFilter;
}

export function toggleEmailFilterValue(
  filter: EmailListFilter,
  field: EmailFilterField,
  value: EmailFilterValue,
): EmailListFilter {
  const values = emailFilterValues(filter, field);
  return withEmailFilterValues(
    filter,
    field,
    values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value],
  );
}

export function activeEmailFilterFields(filter: EmailListFilter): ReadonlyArray<EmailFilterField> {
  return EMAIL_FILTER_FIELDS.filter((field) => emailFilterValues(filter, field).length > 0);
}

export function isEmailListFilterActive(filter: EmailListFilter): boolean {
  return activeEmailFilterFields(filter).length > 0;
}

/** How many values are checked in total — the number on the filter button. */
export function emailListFilterCount(filter: EmailListFilter): number {
  return EMAIL_FILTER_FIELDS.reduce(
    (total, field) => total + emailFilterValues(filter, field).length,
    0,
  );
}

function emailFilterFieldValue(
  message: CapturedEmailSummary,
  field: EmailFilterField,
): EmailFilterValue {
  if (field === "read") return message.isRead ? "read" : "unread";
  if (field === "attachment") return message.attachmentCount > 0 ? "has" : "none";
  return message.detectedCode === null ? "none" : "has";
}

export function emailMatchesFilter(
  message: CapturedEmailSummary,
  filter: EmailListFilter,
): boolean {
  return EMAIL_FILTER_FIELDS.every((field) => {
    const values = emailFilterValues(filter, field);
    return values.length === 0 || values.includes(emailFilterFieldValue(message, field));
  });
}

/**
 * The rows the list shows. Returns the input array untouched when nothing is filtering, so an
 * unfiltered inbox never hands the virtualized list a new array identity per render.
 */
export function filterEmailMessages(
  messages: ReadonlyArray<CapturedEmailSummary>,
  input: { readonly query: string; readonly filter: EmailListFilter },
): ReadonlyArray<CapturedEmailSummary> {
  const terms = emailQueryTerms(input.query);
  const filtering = isEmailListFilterActive(input.filter);
  if (terms.length === 0 && !filtering) return messages;
  return messages.filter(
    (message) => emailMatchesFilter(message, input.filter) && matchesTerms(message, terms),
  );
}

/** "12 messages", or "3 of 12 messages" once a search or a filter is hiding some of them. */
export function emailMessageCountLabel(visible: number, total: number): string {
  const noun = total === 1 ? "message" : "messages";
  return visible === total ? `${total} ${noun}` : `${visible} of ${total} ${noun}`;
}

// ── Selection ──────────────────────────────────────────────────────────

export interface EmailSelection {
  readonly ids: ReadonlySet<EmailMessageId>;
  /** Where a shift-click measures from; the last row checked without shift. */
  readonly anchorId: EmailMessageId | null;
}

const EMPTY_SELECTED_EMAIL_IDS: ReadonlySet<EmailMessageId> = new Set();

export const EMPTY_EMAIL_SELECTION: EmailSelection = Object.freeze({
  ids: EMPTY_SELECTED_EMAIL_IDS,
  anchorId: null,
});

export type EmailSelectMode = "toggle" | "range";

export function emailSelectModeForModifiers(input: {
  readonly shiftKey: boolean;
}): EmailSelectMode {
  return input.shiftKey ? "range" : "toggle";
}

/** Inclusive slice of the display order between two rows, either way round. */
export function emailRangeIds(
  ids: ReadonlyArray<EmailMessageId>,
  fromId: EmailMessageId,
  toId: EmailMessageId,
): ReadonlyArray<EmailMessageId> {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1) return to === -1 ? [] : [toId];
  return from <= to ? ids.slice(from, to + 1) : ids.slice(to, from + 1);
}

/**
 * A checkbox press.
 *
 * Unlike the issue list, a shift-range *adds* to the selection rather than replacing it: these are
 * checkboxes, so every press here is already additive and "check three, then shift-check a block"
 * would otherwise silently drop the three.
 */
export function selectEmailRow(
  selection: EmailSelection,
  input: {
    readonly ids: ReadonlyArray<EmailMessageId>;
    readonly messageId: EmailMessageId;
    readonly mode: EmailSelectMode;
  },
): EmailSelection {
  const { ids, messageId, mode } = input;
  if (mode === "range" && selection.anchorId !== null) {
    const next = new Set(selection.ids);
    for (const id of emailRangeIds(ids, selection.anchorId, messageId)) next.add(id);
    return { ids: next, anchorId: selection.anchorId };
  }
  const next = new Set(selection.ids);
  if (next.has(messageId)) {
    next.delete(messageId);
    return { ids: next, anchorId: null };
  }
  next.add(messageId);
  return { ids: next, anchorId: messageId };
}

/**
 * Drops ids the list no longer shows. Retention, a scope change, and a filter keystroke can all
 * take a row away while it is checked, and a bulk write against rows nobody can see is the worst
 * kind of surprise. Returns the same selection when nothing moved, so the caller's `setState` is a
 * no-op rather than a re-render.
 */
export function pruneEmailSelection(
  selection: EmailSelection,
  ids: ReadonlyArray<EmailMessageId>,
): EmailSelection {
  const visible = new Set(ids);
  let changed = false;
  const next = new Set<EmailMessageId>();
  for (const id of selection.ids) {
    if (visible.has(id)) next.add(id);
    else changed = true;
  }
  const anchorId =
    selection.anchorId !== null && visible.has(selection.anchorId) ? selection.anchorId : null;
  if (!changed && anchorId === selection.anchorId) return selection;
  return { ids: next, anchorId };
}

export type EmailSelectAllState = "none" | "partial" | "all";

export function emailSelectAllState(
  selection: EmailSelection,
  visibleIds: ReadonlyArray<EmailMessageId>,
): EmailSelectAllState {
  if (visibleIds.length === 0) return "none";
  let selected = 0;
  for (const id of visibleIds) if (selection.ids.has(id)) selected += 1;
  if (selected === 0) return "none";
  return selected === visibleIds.length ? "all" : "partial";
}

/** Select-all covers what the list is showing, so a filtered select-all never reaches a hidden row. */
export function toggleEmailSelectAll(
  selection: EmailSelection,
  visibleIds: ReadonlyArray<EmailMessageId>,
): EmailSelection {
  const clearing = emailSelectAllState(selection, visibleIds) === "all";
  const next = new Set(selection.ids);
  for (const id of visibleIds) {
    if (clearing) next.delete(id);
    else next.add(id);
  }
  return { ids: next, anchorId: null };
}

export function selectedEmailMessages(
  messages: ReadonlyArray<CapturedEmailSummary>,
  selection: EmailSelection,
): ReadonlyArray<CapturedEmailSummary> {
  return messages.filter((message) => selection.ids.has(message.id));
}

/**
 * Which rows a menu opened on `message` acts on: the whole selection when the row is part of one,
 * and that row alone otherwise. Right-clicking an unchecked row deliberately does not check it —
 * opening a message and checking it stay separate gestures.
 */
export function emailActionTargets(
  messages: ReadonlyArray<CapturedEmailSummary>,
  selection: EmailSelection,
  message: CapturedEmailSummary,
): ReadonlyArray<CapturedEmailSummary> {
  if (selection.ids.size <= 1 || !selection.ids.has(message.id)) return [message];
  return selectedEmailMessages(messages, selection);
}

/**
 * The counts a row's own menu labels itself with — the {@link emailActionTargets} rule, expressed
 * in the two numbers the labels need, so the menu can never promise a different scope than the one
 * the action will run against.
 */
export function emailRowActionCounts(input: {
  readonly isRead: boolean;
  readonly checked: boolean;
  readonly selectionCount: number;
  readonly selectionUnreadCount: number;
}): { readonly count: number; readonly unreadCount: number } {
  if (input.checked && input.selectionCount > 1) {
    return { count: input.selectionCount, unreadCount: input.selectionUnreadCount };
  }
  return { count: 1, unreadCount: input.isRead ? 0 : 1 };
}

/**
 * The ids a read-state write actually has to send. `email.markRead` is per message, so a select-all
 * over a read inbox would otherwise be one round trip per row to change nothing.
 */
export function emailIdsNeedingReadState(
  messages: ReadonlyArray<CapturedEmailSummary>,
  isRead: boolean,
): ReadonlyArray<EmailMessageId> {
  return messages.filter((message) => message.isRead !== isRead).map((message) => message.id);
}

// ── Actions ────────────────────────────────────────────────────────────

export type EmailMessageAction = "open" | "mark-read" | "mark-unread" | "add-tag" | "delete";

export interface EmailActionMenuItem {
  readonly id: EmailMessageAction;
  readonly label: string;
  readonly disabled: boolean;
  readonly destructive: boolean;
  /**
   * Why a disabled item is disabled. Rendered beside the label in the app's own menu and appended
   * to it in a native one, because a greyed row with no reason reads as a bug.
   */
  readonly unavailableReason: string | null;
  readonly separatorBefore: boolean;
}

/**
 * Captured mail has no per-message delete: `email.clearInbox` takes a whole scope and nothing else
 * removes a row. The action is still listed so the answer to "can I delete this?" is on screen
 * instead of missing, and it says where the real way out is.
 */
const DELETE_UNAVAILABLE_REASON = "This server only clears a whole inbox";
const ADD_TAG_UNAVAILABLE_REASON = "Captured mail has no tags";

/**
 * One action list, shared by the row's three-dot menu, the right-click menu, and the bulk bar's
 * overflow — so the same rows can never disagree about what is possible.
 *
 * `unreadCount` is what makes the read actions honest: marking an already-read message read is a
 * no-op, and an item that would do nothing is disabled rather than quietly successful.
 */
export function emailActionMenuItems(input: {
  readonly count: number;
  readonly unreadCount: number;
  /** Only the single-row menus offer Open; the bulk bar has nothing to open. */
  readonly includeOpen: boolean;
}): ReadonlyArray<EmailActionMenuItem> {
  const { count, unreadCount, includeOpen } = input;
  const items: Array<EmailActionMenuItem> = [];

  if (includeOpen && count === 1) {
    items.push({
      id: "open",
      label: "Open",
      disabled: false,
      destructive: false,
      unavailableReason: null,
      separatorBefore: false,
    });
  }

  items.push({
    id: "mark-read",
    label: count === 1 ? "Mark as read" : `Mark ${count} as read`,
    disabled: unreadCount === 0,
    destructive: false,
    unavailableReason: unreadCount === 0 ? "Already read" : null,
    separatorBefore: items.length > 0,
  });
  items.push({
    id: "mark-unread",
    label: count === 1 ? "Mark as unread" : `Mark ${count} as unread`,
    disabled: unreadCount === count,
    destructive: false,
    unavailableReason: unreadCount === count ? "Already unread" : null,
    separatorBefore: false,
  });
  items.push({
    id: "add-tag",
    label: "Add tag",
    disabled: true,
    destructive: false,
    unavailableReason: ADD_TAG_UNAVAILABLE_REASON,
    separatorBefore: true,
  });
  items.push({
    id: "delete",
    label: count === 1 ? "Delete" : `Delete ${count}`,
    disabled: true,
    destructive: true,
    unavailableReason: DELETE_UNAVAILABLE_REASON,
    separatorBefore: false,
  });

  return items;
}

/**
 * The same list in the shape `localApi.contextMenu` takes. A native menu has no room for a hint
 * beside the label, so the reason is folded into it — an em-dashed suffix survives both surfaces.
 */
export function emailActionContextMenuItems(
  items: ReadonlyArray<EmailActionMenuItem>,
): ReadonlyArray<ContextMenuItem<EmailMessageAction>> {
  return items.map((item) => ({
    id: item.id,
    label:
      item.unavailableReason === null ? item.label : `${item.label} — ${item.unavailableReason}`,
    disabled: item.disabled,
    destructive: item.destructive,
  }));
}
