import { describe, expect, it } from "vite-plus/test";

import {
  BOOTSTRAP_ENTITY_ORDER,
  bootstrapKindAfter,
  decodeBootstrapCursor,
  encodeBootstrapCursor,
  initialBootstrapState,
  type BootstrapEntityKind,
} from "./bootstrap.ts";
import { SYNC_ENTITY_KINDS } from "./protocol.ts";

describe("BOOTSTRAP_ENTITY_ORDER", () => {
  it("names only known entity kinds, each once", () => {
    const known = new Set<string>(SYNC_ENTITY_KINDS);
    for (const kind of BOOTSTRAP_ENTITY_ORDER) expect(known.has(kind)).toBe(true);
    expect(new Set(BOOTSTRAP_ENTITY_ORDER).size).toBe(BOOTSTRAP_ENTITY_ORDER.length);
  });

  it("walks every issue-domain kind and nothing from the company domain", () => {
    const issueDomain = SYNC_ENTITY_KINDS.filter((kind) => kind.startsWith("issue"));
    expect([...BOOTSTRAP_ENTITY_ORDER].sort()).toEqual([...issueDomain].sort());
  });
});

describe("initialBootstrapState", () => {
  it("starts the walk at the first kind, from the top of its table", () => {
    expect(initialBootstrapState(41)).toEqual({
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
      const state = { snapshotVersion: 7, entityKind, afterId: "0198aaaa-1" };
      expect(decodeBootstrapCursor(encodeBootstrapCursor(state))).toEqual(state);
    }
  });

  it("keeps an empty afterId and a zero snapshot", () => {
    const state = { snapshotVersion: 0, entityKind: "issue" as const, afterId: "" };
    expect(decodeBootstrapCursor(encodeBootstrapCursor(state))).toEqual(state);
  });
});

describe("decodeBootstrapCursor refusals", () => {
  it.each([
    ["not JSON", "definitely-not-json"],
    ["a JSON scalar", "42"],
    ["a JSON array", "[1,2,3]"],
    ["missing keys", "{}"],
    ["a string version", '{"v":"1","k":"issue","a":""}'],
    ["a negative version", '{"v":-1,"k":"issue","a":""}'],
    ["a non-finite version", '{"v":null,"k":"issue","a":""}'],
    ["an unknown entity kind", '{"v":1,"k":"holograms","a":""}'],
    ["a company-domain entity kind", '{"v":1,"k":"membership","a":""}'],
    ["a non-string afterId", '{"v":1,"k":"issue","a":7}'],
  ])("returns null for %s", (_label, token) => {
    expect(decodeBootstrapCursor(token)).toBeNull();
  });
});
