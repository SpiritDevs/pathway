import { describe, expect, it } from "vite-plus/test";

import { checkOwnershipChange, remainingOwners, wouldRemoveLastOwner } from "./ownership.ts";

describe("last-owner protection", () => {
  it("allows removing one of several owners", () => {
    expect(wouldRemoveLastOwner(["m-1", "m-2"], ["m-1"])).toBe(false);
    expect(remainingOwners(["m-1", "m-2"], ["m-1"])).toEqual(["m-2"]);
    expect(checkOwnershipChange(["m-1", "m-2"], ["m-1"])).toBeNull();
  });

  it("refuses to remove the only owner", () => {
    expect(wouldRemoveLastOwner(["m-1"], ["m-1"])).toBe(true);
    expect(checkOwnershipChange(["m-1"], ["m-1"])).toBe("last-owner-protected");
  });

  it("refuses a bulk change that would clear every owner", () => {
    expect(checkOwnershipChange(["m-1", "m-2"], ["m-1", "m-2"])).toBe("last-owner-protected");
  });

  it("ignores a removal of somebody who is not an owner", () => {
    expect(checkOwnershipChange(["m-1"], ["m-9"])).toBeNull();
  });
});
