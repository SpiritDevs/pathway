import { assert, describe, it } from "@effect/vitest";

import { isIssueSortOrder, issueSortOrderAfter, issueSortOrderBetween } from "./sortOrder.ts";

describe("issueSortOrderBetween", () => {
  it("orders the three unbounded insertions", () => {
    const middle = issueSortOrderBetween(null, null)!;
    const top = issueSortOrderBetween(null, middle)!;
    const bottom = issueSortOrderBetween(middle, null)!;

    assert.isTrue(top < middle);
    assert.isTrue(middle < bottom);
  });

  it("splits adjacent digits without colliding", () => {
    const key = issueSortOrderBetween("g", "h")!;

    assert.isTrue("g" < key && key < "h");
  });

  it("stays strictly ordered under a thousand head insertions", () => {
    let head = issueSortOrderBetween(null, null)!;
    for (let index = 0; index < 1_000; index += 1) {
      const key = issueSortOrderBetween(null, head)!;
      assert.isTrue(key < head);
      head = key;
    }
  });

  it("stays strictly ordered under a thousand insertions into one gap", () => {
    let low = issueSortOrderBetween(null, null)!;
    const high = issueSortOrderBetween(low, null)!;
    for (let index = 0; index < 1_000; index += 1) {
      const key = issueSortOrderBetween(low, high)!;
      assert.isTrue(low < key && key < high);
      low = key;
    }
  });

  it("refuses corrupt and out-of-order bounds", () => {
    assert.isNull(issueSortOrderBetween("g1", null));
    assert.isNull(issueSortOrderBetween(null, "G"));
    // A trailing minimum digit leaves nothing to sort before it.
    assert.isNull(issueSortOrderBetween("ba", null));
    assert.isNull(issueSortOrderBetween("m", "d"));
    assert.isNull(issueSortOrderBetween("m", "m"));
  });
});

describe("issueSortOrderAfter", () => {
  it("appends after the last key in a status", () => {
    let last: string | null = null;
    const keys: Array<string> = [];
    for (let index = 0; index < 250; index += 1) {
      last = issueSortOrderAfter(last);
      keys.push(last);
    }

    assert.deepStrictEqual(keys, [...keys].toSorted());
    assert.strictEqual(new Set(keys).size, keys.length);
    assert.isTrue(keys.every(isIssueSortOrder));
  });

  it("still sorts after a corrupt key rather than failing the create", () => {
    assert.isTrue(issueSortOrderAfter("imported-garbage") > "imported-garbage");
  });
});
