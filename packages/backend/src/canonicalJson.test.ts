import { describe, expect, it } from "vite-plus/test";

import { canonicalJson } from "./canonicalJson.ts";

describe("canonicalJson", () => {
  it("ignores object key order at every depth but keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
