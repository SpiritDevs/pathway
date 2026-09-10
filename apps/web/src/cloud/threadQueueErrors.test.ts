import { describe, expect, it } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { isDefinitiveQueueRejection } from "./threadQueueErrors";

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
