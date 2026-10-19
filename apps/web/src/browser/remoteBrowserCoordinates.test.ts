import { describe, expect, it } from "vite-plus/test";
import { remoteBrowserPoint } from "./remoteBrowserCoordinates";

describe("remote browser coordinates", () => {
  it("maps a scaled Retina preview back to CSS coordinates", () => {
    expect(
      remoteBrowserPoint({
        x: 320,
        y: 180,
        boxWidth: 640,
        boxHeight: 360,
        width: 1280,
        height: 720,
      }),
    ).toEqual({ x: 640, y: 360 });
  });
  it("removes letterboxing and ignores clicks in the empty margins", () => {
    const viewport = { boxWidth: 600, boxHeight: 600, width: 1200, height: 800 };
    expect(remoteBrowserPoint({ ...viewport, x: 300, y: 300 })).toEqual({ x: 600, y: 400 });
    expect(remoteBrowserPoint({ ...viewport, x: 300, y: 99 })).toBeNull();
    expect(remoteBrowserPoint({ ...viewport, x: 300, y: 501 })).toBeNull();
  });
  it("does not send invalid or edge-outside coordinates", () => {
    expect(
      remoteBrowserPoint({ x: 0, y: 0, boxWidth: 0, boxHeight: 1, width: 1, height: 1 }),
    ).toBeNull();
    expect(
      remoteBrowserPoint({ x: 100, y: 50, boxWidth: 100, boxHeight: 100, width: 100, height: 100 }),
    ).toBeNull();
  });
});
