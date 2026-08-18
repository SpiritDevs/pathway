import type { CapturedEmailSummary, EmailMessageId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_EMAIL_SELECTION,
  NO_EMAIL_LIST_FILTER,
  emailActionContextMenuItems,
  emailActionMenuItems,
  emailActionTargets,
  emailIdsNeedingReadState,
  emailListFilterCount,
  emailMatchesFilter,
  emailMatchesQuery,
  emailMessageCountLabel,
  emailMessageSelectionId,
  emailRangeIds,
  emailRowActionCounts,
  emailSelectAllState,
  emailSelectModeForModifiers,
  filterEmailMessages,
  isEmailListFilterActive,
  pruneEmailSelection,
  selectEmailRow,
  selectedEmailMessages,
  toggleEmailFilterValue,
  toggleEmailSelectAll,
  type EmailSelection,
} from "./emailList.logic";

const id = (value: string) => value as EmailMessageId;

function message(
  overrides: Partial<Omit<CapturedEmailSummary, "id">> & { id: string },
): CapturedEmailSummary {
  return {
    attribution: {
      projectId: null,
      mailSlug: null,
      matchedBy: "unassigned",
      matchedValue: null,
    },
    from: [{ name: "QuoteCloud", address: "no-reply@quotecloud.test" }],
    to: [{ name: null, address: "tester@example.test" }],
    subject: "Authorize your QuoteCloud admin session",
    textPreview: "Your QuoteCloud authorization code is ready.",
    receivedAt: "2026-08-13T11:49:00.000Z",
    sizeBytes: 2048,
    attachmentCount: 0,
    isRead: false,
    detectedCode: null,
    ...overrides,
    id: id(overrides.id),
  } as unknown as CapturedEmailSummary;
}

const unreadWithCode = message({ id: "m1", detectedCode: "4JJVYX" });
const readWithAttachment = message({
  id: "m2",
  isRead: true,
  attachmentCount: 2,
  subject: "Invoice for August",
  from: [{ name: "Billing", address: "billing@stripe.test" }],
  textPreview: "Attached is your receipt.",
});
const plainRead = message({
  id: "m3",
  isRead: true,
  subject: null,
  textPreview: "No subject here.",
  to: [{ name: "Ops", address: "ops@example.test" }],
});
const ALL = [unreadWithCode, readWithAttachment, plainRead];
const ALL_IDS = ALL.map((entry) => entry.id);

describe("emailMatchesQuery", () => {
  it("reads sender, recipients, subject, preview, and detected code", () => {
    expect(emailMatchesQuery(unreadWithCode, "quotecloud")).toBe(true);
    expect(emailMatchesQuery(unreadWithCode, "tester@example.test")).toBe(true);
    expect(emailMatchesQuery(unreadWithCode, "authorize")).toBe(true);
    expect(emailMatchesQuery(unreadWithCode, "authorization code")).toBe(true);
    expect(emailMatchesQuery(unreadWithCode, "4jjvyx")).toBe(true);
    expect(emailMatchesQuery(plainRead, "ops")).toBe(true);
  });

  it("treats terms as an AND across fields rather than a phrase", () => {
    expect(emailMatchesQuery(readWithAttachment, "stripe invoice")).toBe(true);
    expect(emailMatchesQuery(readWithAttachment, "stripe quotecloud")).toBe(false);
  });

  it("matches everything when the query is blank", () => {
    expect(emailMatchesQuery(plainRead, "   ")).toBe(true);
  });
});

describe("quick filters", () => {
  it("starts inactive and counts each checked value", () => {
    expect(isEmailListFilterActive(NO_EMAIL_LIST_FILTER)).toBe(false);
    const filter = toggleEmailFilterValue(
      toggleEmailFilterValue(NO_EMAIL_LIST_FILTER, "read", "unread"),
      "attachment",
      "has",
    );
    expect(isEmailListFilterActive(filter)).toBe(true);
    expect(emailListFilterCount(filter)).toBe(2);
  });

  it("toggles a value back off without disturbing the other fields", () => {
    const filter = toggleEmailFilterValue(NO_EMAIL_LIST_FILTER, "read", "unread");
    expect(toggleEmailFilterValue(filter, "read", "unread")).toEqual(NO_EMAIL_LIST_FILTER);
  });

  it("ORs inside a field and ANDs across them", () => {
    const bothStatuses = toggleEmailFilterValue(
      toggleEmailFilterValue(NO_EMAIL_LIST_FILTER, "read", "unread"),
      "read",
      "read",
    );
    expect(ALL.every((entry) => emailMatchesFilter(entry, bothStatuses))).toBe(true);

    const unreadWithAttachment = toggleEmailFilterValue(
      toggleEmailFilterValue(NO_EMAIL_LIST_FILTER, "read", "unread"),
      "attachment",
      "has",
    );
    expect(ALL.filter((entry) => emailMatchesFilter(entry, unreadWithAttachment))).toEqual([]);
  });

  it("filters on attachments and detected code in both directions", () => {
    const hasCode = toggleEmailFilterValue(NO_EMAIL_LIST_FILTER, "code", "has");
    expect(ALL.filter((entry) => emailMatchesFilter(entry, hasCode))).toEqual([unreadWithCode]);

    const noAttachment = toggleEmailFilterValue(NO_EMAIL_LIST_FILTER, "attachment", "none");
    expect(ALL.filter((entry) => emailMatchesFilter(entry, noAttachment))).toEqual([
      unreadWithCode,
      plainRead,
    ]);
  });
});

describe("filterEmailMessages", () => {
  it("hands back the same array when nothing is filtering", () => {
    expect(filterEmailMessages(ALL, { query: "", filter: NO_EMAIL_LIST_FILTER })).toBe(ALL);
  });

  it("composes the search with the quick filters", () => {
    const read = toggleEmailFilterValue(NO_EMAIL_LIST_FILTER, "read", "read");
    // "quotecloud" alone matches two rows; the read filter is what drops the unread one.
    expect(filterEmailMessages(ALL, { query: "quotecloud", filter: NO_EMAIL_LIST_FILTER })).toEqual(
      [unreadWithCode, plainRead],
    );
    expect(filterEmailMessages(ALL, { query: "quotecloud", filter: read })).toEqual([plainRead]);
    expect(filterEmailMessages(ALL, { query: "invoice", filter: read })).toEqual([
      readWithAttachment,
    ]);
  });
});

describe("emailMessageCountLabel", () => {
  it("names the total, and the visible share once something is hidden", () => {
    expect(emailMessageCountLabel(3, 3)).toBe("3 messages");
    expect(emailMessageCountLabel(1, 1)).toBe("1 message");
    expect(emailMessageCountLabel(1, 12)).toBe("1 of 12 messages");
  });
});

describe("selectEmailRow", () => {
  it("toggles a row on and back off", () => {
    const checked = selectEmailRow(EMPTY_EMAIL_SELECTION, {
      ids: ALL_IDS,
      messageId: id("m1"),
      mode: "toggle",
    });
    expect([...checked.ids]).toEqual([id("m1")]);
    expect(checked.anchorId).toBe(id("m1"));

    const cleared = selectEmailRow(checked, { ids: ALL_IDS, messageId: id("m1"), mode: "toggle" });
    expect(cleared.ids.size).toBe(0);
    expect(cleared.anchorId).toBeNull();
  });

  it("adds a shift-range to the selection rather than replacing it", () => {
    const anchored = selectEmailRow(EMPTY_EMAIL_SELECTION, {
      ids: ALL_IDS,
      messageId: id("m1"),
      mode: "toggle",
    });
    const ranged = selectEmailRow(anchored, {
      ids: ALL_IDS,
      messageId: id("m3"),
      mode: "range",
    });
    expect([...ranged.ids]).toEqual([id("m1"), id("m2"), id("m3")]);
    expect(ranged.anchorId).toBe(id("m1"));
  });

  it("falls back to a plain toggle when there is no anchor to measure from", () => {
    const ranged = selectEmailRow(EMPTY_EMAIL_SELECTION, {
      ids: ALL_IDS,
      messageId: id("m2"),
      mode: "range",
    });
    expect([...ranged.ids]).toEqual([id("m2")]);
  });
});

describe("emailRangeIds", () => {
  it("slices inclusively either way round", () => {
    expect(emailRangeIds(ALL_IDS, id("m3"), id("m1"))).toEqual([id("m1"), id("m2"), id("m3")]);
    expect(emailRangeIds(ALL_IDS, id("m2"), id("m2"))).toEqual([id("m2")]);
  });
});

describe("emailSelectModeForModifiers", () => {
  it("only shift means range", () => {
    expect(emailSelectModeForModifiers({ shiftKey: true })).toBe("range");
    expect(emailSelectModeForModifiers({ shiftKey: false })).toBe("toggle");
  });
});

describe("pruneEmailSelection", () => {
  it("drops ids the list stopped showing and forgets an unreachable anchor", () => {
    const selection: EmailSelection = { ids: new Set([id("m1"), id("m2")]), anchorId: id("m2") };
    const pruned = pruneEmailSelection(selection, [id("m1")]);
    expect([...pruned.ids]).toEqual([id("m1")]);
    expect(pruned.anchorId).toBeNull();
  });

  it("returns the same selection when nothing moved, so setState is a no-op", () => {
    const selection: EmailSelection = { ids: new Set([id("m1")]), anchorId: id("m1") };
    expect(pruneEmailSelection(selection, ALL_IDS)).toBe(selection);
  });
});

describe("select all", () => {
  it("reports none, partial, and all against the visible rows", () => {
    expect(emailSelectAllState(EMPTY_EMAIL_SELECTION, ALL_IDS)).toBe("none");
    expect(emailSelectAllState({ ids: new Set([id("m1")]), anchorId: null }, ALL_IDS)).toBe(
      "partial",
    );
    expect(emailSelectAllState({ ids: new Set(ALL_IDS), anchorId: null }, ALL_IDS)).toBe("all");
    expect(emailSelectAllState(EMPTY_EMAIL_SELECTION, [])).toBe("none");
  });

  it("covers only the filtered rows, and clears them again", () => {
    const filtered = [id("m1"), id("m2")];
    const all = toggleEmailSelectAll(EMPTY_EMAIL_SELECTION, filtered);
    expect([...all.ids]).toEqual(filtered);
    expect(toggleEmailSelectAll(all, filtered).ids.size).toBe(0);
  });

  it("promotes a partial selection to all rather than clearing it", () => {
    const partial: EmailSelection = { ids: new Set([id("m2")]), anchorId: id("m2") };
    expect(toggleEmailSelectAll(partial, ALL_IDS).ids).toEqual(new Set(ALL_IDS));
  });
});

describe("emailActionTargets", () => {
  it("acts on the whole selection when the row is part of one", () => {
    const selection: EmailSelection = { ids: new Set([id("m1"), id("m3")]), anchorId: null };
    expect(emailActionTargets(ALL, selection, unreadWithCode)).toEqual([unreadWithCode, plainRead]);
  });

  it("acts on the row alone when it is not checked, leaving the selection alone", () => {
    const selection: EmailSelection = { ids: new Set([id("m1"), id("m3")]), anchorId: null };
    expect(emailActionTargets(ALL, selection, readWithAttachment)).toEqual([readWithAttachment]);
  });
});

describe("selectedEmailMessages", () => {
  it("keeps display order rather than selection order", () => {
    const selection: EmailSelection = { ids: new Set([id("m3"), id("m1")]), anchorId: null };
    expect(selectedEmailMessages(ALL, selection)).toEqual([unreadWithCode, plainRead]);
  });

  it("keeps identical source ids independently selectable across companies", () => {
    const companyA = {
      ...unreadWithCode,
      companyId: "company-a",
      environmentId: "environment-one",
    };
    const companyB = {
      ...unreadWithCode,
      companyId: "company-b",
      environmentId: "environment-one",
    };
    const companyAKey = emailMessageSelectionId(companyA);
    const selection: EmailSelection = { ids: new Set([companyAKey]), anchorId: companyAKey };

    expect(emailMessageSelectionId(companyA)).not.toBe(emailMessageSelectionId(companyB));
    expect(selectedEmailMessages([companyA, companyB], selection)).toEqual([companyA]);
  });
});

describe("emailIdsNeedingReadState", () => {
  it("skips rows already in the target state", () => {
    expect(emailIdsNeedingReadState(ALL, true)).toEqual([id("m1")]);
    expect(emailIdsNeedingReadState(ALL, false)).toEqual([id("m2"), id("m3")]);
    expect(emailIdsNeedingReadState([readWithAttachment], true)).toEqual([]);
  });
});

describe("emailRowActionCounts", () => {
  it("counts the selection when the row belongs to a multi-row one", () => {
    expect(
      emailRowActionCounts({
        isRead: false,
        checked: true,
        selectionCount: 4,
        selectionUnreadCount: 1,
      }),
    ).toEqual({ count: 4, unreadCount: 1 });
  });

  it("counts just the row otherwise", () => {
    expect(
      emailRowActionCounts({
        isRead: false,
        checked: false,
        selectionCount: 4,
        selectionUnreadCount: 1,
      }),
    ).toEqual({ count: 1, unreadCount: 1 });
    expect(
      emailRowActionCounts({
        isRead: true,
        checked: true,
        selectionCount: 1,
        selectionUnreadCount: 0,
      }),
    ).toEqual({ count: 1, unreadCount: 0 });
  });
});

describe("emailActionMenuItems", () => {
  it("names the count it will act on", () => {
    const single = emailActionMenuItems({ count: 1, unreadCount: 1, includeOpen: true });
    expect(single.map((item) => item.label)).toEqual([
      "Open",
      "Mark as read",
      "Mark as unread",
      "Add tag",
      "Delete",
    ]);

    const bulk = emailActionMenuItems({ count: 3, unreadCount: 1, includeOpen: false });
    expect(bulk.map((item) => item.label)).toEqual([
      "Mark 3 as read",
      "Mark 3 as unread",
      "Add tag",
      "Delete 3",
    ]);
  });

  it("disables a read action that would not change anything, and says why", () => {
    const allRead = emailActionMenuItems({ count: 2, unreadCount: 0, includeOpen: false });
    const markRead = allRead.find((item) => item.id === "mark-read");
    expect(markRead?.disabled).toBe(true);
    expect(markRead?.unavailableReason).toBe("Already read");
    expect(allRead.find((item) => item.id === "mark-unread")?.disabled).toBe(false);

    const allUnread = emailActionMenuItems({ count: 2, unreadCount: 2, includeOpen: false });
    expect(allUnread.find((item) => item.id === "mark-read")?.disabled).toBe(false);
    expect(allUnread.find((item) => item.id === "mark-unread")?.unavailableReason).toBe(
      "Already unread",
    );
  });

  it("enables delete and tagging on every message surface", () => {
    const items = emailActionMenuItems({ count: 1, unreadCount: 1, includeOpen: true });
    const remove = items.find((item) => item.id === "delete");
    expect(remove?.disabled).toBe(false);
    expect(remove?.destructive).toBe(true);
    expect(remove?.unavailableReason).toBeNull();
    expect(items.find((item) => item.id === "add-tag")).toMatchObject({
      disabled: false,
      unavailableReason: null,
    });
  });

  it("offers Open only for a single row", () => {
    expect(
      emailActionMenuItems({ count: 2, unreadCount: 1, includeOpen: true }).some(
        (item) => item.id === "open",
      ),
    ).toBe(false);
  });
});

describe("emailActionContextMenuItems", () => {
  it("folds read-state reasons into native menu labels", () => {
    const items = emailActionContextMenuItems(
      emailActionMenuItems({ count: 1, unreadCount: 0, includeOpen: true }),
    );
    expect(items).toEqual([
      { id: "open", label: "Open", disabled: false, destructive: false },
      { id: "mark-read", label: "Mark as read — Already read", disabled: true, destructive: false },
      { id: "mark-unread", label: "Mark as unread", disabled: false, destructive: false },
      {
        id: "add-tag",
        label: "Add tag",
        disabled: false,
        destructive: false,
      },
      {
        id: "delete",
        label: "Delete",
        disabled: false,
        destructive: true,
      },
    ]);
  });
});
