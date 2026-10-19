import { describe, expect, it } from "vite-plus/test";

import { contactInitials, filterContacts, type ContactRecord } from "./contacts.logic";

const contact = (overrides: Partial<ContactRecord>): ContactRecord => ({
  id: "contact-1",
  name: "Ada Lovelace",
  role: "Engineer",
  company: "Analytical Engines",
  email: "ada@example.com",
  phone: "+61 400 000 000",
  notes: "",
  favorite: false,
  createdAt: "2026-08-15T00:00:00.000Z",
  ...overrides,
});

describe("contactInitials", () => {
  it("uses the first and last words", () => {
    expect(contactInitials("Ada King Lovelace")).toBe("AL");
    expect(contactInitials("Prince")).toBe("P");
  });
});

describe("filterContacts", () => {
  it("matches across useful fields and keeps favorites first", () => {
    const contacts = [
      contact({ id: "1", name: "Ada Lovelace" }),
      contact({ id: "2", name: "Grace Hopper", company: "Navy", favorite: true }),
    ];

    expect(filterContacts(contacts, "navy").map(({ id }) => id)).toEqual(["2"]);
    expect(filterContacts(contacts, "").map(({ id }) => id)).toEqual(["2", "1"]);
  });
});
