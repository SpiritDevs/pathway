import { describe, expect, it } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { isDefinitiveQueueRejection, isQueueEntityNotFound } from "./threadQueueErrors";

describe("queue submission rejection fences", () => {
  it("releases conflicting identities for local cancellation", () => {
    expect(isDefinitiveQueueRejection(new ConvexError({ code: "submission-conflict" }))).toBe(true);
    expect(isDefinitiveQueueRejection(new ConvexError({ code: "thread-unavailable" }))).toBe(true);
  });
  it("keeps uncertain transport and unknown failures fenced", () => {
    expect(isDefinitiveQueueRejection(new Error("Connection lost"))).toBe(false);
    expect(isDefinitiveQueueRejection(new ConvexError({ code: "unknown" }))).toBe(false);
  });
});

it("treats only a missing cloud entity as already deleted", () => {
  expect(isQueueEntityNotFound(new ConvexError({ code: "entity-not-found" }))).toBe(true);
  expect(isQueueEntityNotFound(new ConvexError({ code: "permission-denied" }))).toBe(false);
  expect(isQueueEntityNotFound(new Error("entity-not-found"))).toBe(false);
});
