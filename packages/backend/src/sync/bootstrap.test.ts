import { describe, expect, it } from "vite-plus/test";

import {
  BOOTSTRAP_ENTITY_ORDER,
  bootstrapKindAfter,
  decodeBootstrapCursor,
  encodeBootstrapCursor,
  initialBootstrapState,
  type BootstrapCursorState,
  type BootstrapEntityKind,
} from "./bootstrap.ts";
import { SYNC_ENTITY_KINDS } from "./protocol.ts";

/**
 * The walk as the deployment before the company domain joined it minted cursors against. Kept as a
 * literal so the append-only rule is checked against history rather than against itself.
 */
const ISSUE_DOMAIN_WALK = [
  "issueStatus",
  "issueLabel",
  "issueMilestone",
  "issueCycle",
  "issue",
  "issueTodo",
  "issueRelation",
  "issueComment",
  "issueAttachment",
  "issueView",
  "issueThreadLink",
  "issueAuditEvent",
] as const;

const COMPANY_DOMAIN_WALK = [
  "company",
  "companySettings",
  "membership",
  "team",
  "teamMembership",
  "role",
  "roleAssignment",
  "environmentRegistration",
  "environmentBinding",
  "environmentCommand",
  "cloudProject",
] as const;

describe("BOOTSTRAP_ENTITY_ORDER", () => {
  it("names only known entity kinds, each once", () => {
    const known = new Set<string>(SYNC_ENTITY_KINDS);
    for (const kind of BOOTSTRAP_ENTITY_ORDER) expect(known.has(kind)).toBe(true);
    expect(new Set(BOOTSTRAP_ENTITY_ORDER).size).toBe(BOOTSTRAP_ENTITY_ORDER.length);
  });

  it("walks both replicated domains, issue kinds then company kinds", () => {
    expect([...BOOTSTRAP_ENTITY_ORDER]).toEqual([...ISSUE_DOMAIN_WALK, ...COMPANY_DOMAIN_WALK]);
  });

  it("grew append-only: the previous walk is still a prefix of this one", () => {
    // Inserting a kind mid-list silently skips that table for every cursor already past the
    // insertion point, and the miss surfaces only as a replica that is quietly short a table.
    expect([...BOOTSTRAP_ENTITY_ORDER].slice(0, ISSUE_DOMAIN_WALK.length)).toEqual([
      ...ISSUE_DOMAIN_WALK,
    ]);
  });

  it("includes cloud projects once their import mutation appends them to the feed", () => {
    const walked = new Set<string>(BOOTSTRAP_ENTITY_ORDER);
    expect(walked.has("cloudProject")).toBe(true);
  });
});

const COMPANY = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const OTHER_COMPANY = "0198c0de-aaaa-7aaa-8aaa-000000000002";

describe("initialBootstrapState", () => {
  it("starts the walk at the first kind, from the top of its table", () => {
    expect(initialBootstrapState(COMPANY, 41)).toEqual({
      companyId: COMPANY,
      snapshotVersion: 41,
      entityKind: BOOTSTRAP_ENTITY_ORDER[0],
      afterId: "",
    });
  });
});

describe("bootstrapKindAfter", () => {
  it("chains through the whole order exactly once and ends at null", () => {
    const walked: BootstrapEntityKind[] = [];
    let kind: BootstrapEntityKind | null = BOOTSTRAP_ENTITY_ORDER[0];
    while (kind !== null) {
      walked.push(kind);
      kind = bootstrapKindAfter(kind);
    }
    expect(walked).toEqual([...BOOTSTRAP_ENTITY_ORDER]);
  });
});

describe("cursor token round trip", () => {
  it("decodes exactly what it encoded, for every kind", () => {
    for (const entityKind of BOOTSTRAP_ENTITY_ORDER) {
      const state = {
        companyId: COMPANY,
        snapshotVersion: 7,
        entityKind,
        afterId: "0198aaaa-1",
      };
      expect(decodeBootstrapCursor(encodeBootstrapCursor(state), COMPANY)).toEqual(state);
    }
  });

  it("keeps an empty afterId and a zero snapshot", () => {
    const state = {
      companyId: COMPANY,
      snapshotVersion: 0,
      entityKind: "issue" as const,
      afterId: "",
    };
    expect(decodeBootstrapCursor(encodeBootstrapCursor(state), COMPANY)).toEqual(state);
  });
});

/** A cursor this deployment really minted, for the fields a refusal test wants to spoil. */
function minted(overrides: Partial<BootstrapCursorState> = {}): string {
  return encodeBootstrapCursor({
    companyId: COMPANY,
    snapshotVersion: 3,
    entityKind: "issue",
    afterId: "0198aaaa-1",
    ...overrides,
  });
}

/** The same token with one field rewritten *after* the checksum was computed over the original. */
function tampered(field: string, value: unknown): string {
  const token = JSON.parse(minted()) as Record<string, unknown>;
  token[field] = value;
  return JSON.stringify(token);
}

describe("decodeBootstrapCursor refusals", () => {
  it.each([
    ["not JSON", "definitely-not-json"],
    ["a JSON scalar", "42"],
    ["a JSON array", "[1,2,3]"],
    ["missing keys", "{}"],
    ["a token with no checksum at all", '{"c":"' + COMPANY + '","v":1,"k":"issue","a":""}'],
    ["a string version", tampered("v", "1")],
    ["a negative version", tampered("v", -1)],
    ["a non-finite version", tampered("v", null)],
    // The version comes back as the seed's resume cursor and the client decodes it as a company
    // version, so anything that is not a whole number it could compare against the feed is refused.
    ["a fractional version", tampered("v", 1.5)],
    ["a version past the safe-integer range", tampered("v", 1e21)],
    ["an unknown entity kind", tampered("k", "holograms")],
    // A real entity kind the walk does not cover: known to the protocol, but not a table this seed
    // pages, so a token naming it has no walk position to resume from.
    ["an entity kind outside the walk", tampered("k", "environmentCommand")],
    ["a non-string afterId", tampered("a", 7)],
    ["an untrimmed afterId the walk could never stop on", tampered("a", " 0198aaaa-1")],
    ["an afterId past the id ceiling", tampered("a", "z".repeat(129))],
    ["a checksum from a different walk position", tampered("x", "deadbeef")],
  ])("returns null for %s", (_label, token) => {
    expect(decodeBootstrapCursor(token, COMPANY)).toBeNull();
  });

  it("refuses a well-formed token minted for another company", () => {
    const token = encodeBootstrapCursor({
      companyId: OTHER_COMPANY,
      snapshotVersion: 3,
      entityKind: "issue",
      afterId: "0198aaaa-1",
    });
    expect(decodeBootstrapCursor(token, OTHER_COMPANY)).not.toBeNull();
    expect(decodeBootstrapCursor(token, COMPANY)).toBeNull();
  });

  it("refuses a walk position edited under an intact-looking token", () => {
    // The corruption this catches is the quiet one: a token naming the last table past every id
    // finishes the seed immediately, and the client persists an empty replica as a complete one.
    const last = BOOTSTRAP_ENTITY_ORDER[BOOTSTRAP_ENTITY_ORDER.length - 1];
    const skipped = JSON.parse(minted()) as Record<string, unknown>;
    skipped["k"] = last;
    skipped["a"] = "zzzzzzzz";
    expect(decodeBootstrapCursor(JSON.stringify(skipped), COMPANY)).toBeNull();
  });
});
