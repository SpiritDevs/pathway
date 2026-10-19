import { describe, expect, it } from "vite-plus/test";
import type { BusinessContactPage } from "@spiritdevs/contracts/businessTools";
import { contactPaginationReducer, initialContactPagination } from "./contactPagination";

const first: BusinessContactPage = {
  contacts: [
    {
      id: "first",
      name: "First",
      role: "",
      company: "Match",
      email: "",
      phone: "",
      notes: "",
      favorite: true,
      createdAt: "",
      revision: 1,
    },
  ],
  cursor: "second-page",
  isDone: false,
};
const history = {
  base: first,
  contacts: [...first.contacts, { ...first.contacts[0]!, id: "older favorite" }],
  cursor: null,
  isDone: true,
};

describe("Contact pages after accepted edits", () => {
  it("returns to the live first page and its cursor when an appended result is edited or unfavorited", () => {
    const loaded = contactPaginationReducer(initialContactPagination, {
      type: "loaded",
      generation: 0,
      history,
    });
    expect(loaded.history?.contacts).toHaveLength(2);
    const saved = contactPaginationReducer(loaded, { type: "invalidate" });
    expect((saved.history?.contacts ?? first.contacts).map((row) => row.id)).toEqual(["first"]);
    expect(saved.history?.cursor ?? first.cursor).toBe("second-page");
    expect(saved.generation).toBe(1);
  });
  it("rejects an old page completion even when the live first page has not emitted after the edit", () => {
    const pending = contactPaginationReducer(initialContactPagination, {
      type: "request",
      generation: 0,
      base: first,
    });
    const saved = contactPaginationReducer(pending, { type: "invalidate" });
    expect(contactPaginationReducer(saved, { type: "loaded", generation: 0, history })).toBe(saved);
    expect(
      contactPaginationReducer(saved, {
        type: "failed",
        generation: 0,
        base: first,
        error: "Old failure",
      }),
    ).toBe(saved);
    expect(saved.request).toBeNull();
  });
  it("allows loading the updated next page after invalidation without accepting a late older failure", () => {
    const saved = contactPaginationReducer(initialContactPagination, { type: "invalidate" });
    const next = contactPaginationReducer(saved, { type: "request", generation: 1, base: first });
    const stale = contactPaginationReducer(next, {
      type: "failed",
      generation: 0,
      base: first,
      error: "Old failure",
    });
    expect(stale.request?.loading).toBe(true);
    const loaded = contactPaginationReducer(stale, {
      type: "loaded",
      generation: 1,
      history: { ...history, contacts: first.contacts },
    });
    expect(loaded.history?.contacts.map((row) => row.id)).toEqual(["first"]);
    expect(loaded.request?.loading).toBe(false);
  });
  it("keeps an accepted local deletion out of the currently appended page", () => {
    const loaded = contactPaginationReducer(initialContactPagination, {
      type: "loaded",
      generation: 0,
      history,
    });
    const removed = contactPaginationReducer(loaded, {
      type: "remove",
      base: first,
      id: "older favorite",
    });
    expect(removed.history?.contacts.map((row) => row.id)).toEqual(["first"]);
  });
});
