import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { ComputerSurfaceInput } from "./computerSurface.ts";
import { EnvironmentSurfaceTarget } from "./environmentSurface.ts";

describe("computer surface wire contracts", () => {
  it("accepts a screen independent of any thread and preserves browser targets", () => {
    const decode = Schema.decodeUnknownSync(EnvironmentSurfaceTarget);
    expect(decode({ kind: "computer", computerId: "desktop" })).toEqual({
      kind: "computer",
      computerId: "desktop",
    });
    expect(decode({ kind: "browser", threadId: "t", tabId: "tab" })).toMatchObject({
      kind: "browser",
    });
    expect(() => decode({ kind: "computer", spaceId: 3 })).toThrow();
  });
  it("bounds high-frequency input and accepts fractional desktop points", () => {
    const decode = Schema.decodeUnknownSync(ComputerSurfaceInput);
    for (const type of ["pointer.move", "pointer.down", "pointer.up", "pointer.click", "wheel"]) {
      expect(decode({ type, x: 1.5, y: 3.25, deltaX: 0.25, deltaY: 10.5 }).type).toBe(type);
    }
    expect(decode({ type: "key", key: "Escape" }).type).toBe("key");
    expect(() => decode({ type: "pointer.move", x: Infinity, y: 0 })).toThrow();
    expect(() => decode({ type: "type", text: "a".repeat(16385) })).toThrow();
    expect(() => decode({ type: "wheel", x: 0, y: 0, deltaX: 10001, deltaY: 0 })).toThrow();
  });
});
