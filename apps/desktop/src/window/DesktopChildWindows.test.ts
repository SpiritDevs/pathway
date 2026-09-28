import { assert, describe, it } from "@effect/vitest";

import * as DesktopChildWindows from "./DesktopChildWindows.ts";

describe("DesktopChildWindows", () => {
  it("puts the window query before the hash route", () => {
    assert.equal(
      DesktopChildWindows.buildChildWindowUrl("pathway://app/", "window-a", "/email"),
      "pathway://app/?pathwayWindow=window-a#/email",
    );
    assert.equal(
      DesktopChildWindows.buildChildWindowUrl("http://127.0.0.1:5733", "window-a", "calendar"),
      "http://127.0.0.1:5733/?pathwayWindow=window-a#/calendar",
    );
  });

  it("reads the hash route back out of a renderer URL", () => {
    assert.equal(
      DesktopChildWindows.childWindowPathFromUrl(
        "pathway://app/?pathwayWindow=window-a#/threads/t-1?tab=diff",
      ),
      "/threads/t-1?tab=diff",
    );
    assert.equal(
      DesktopChildWindows.childWindowPathFromUrl("pathway://app/?pathwayWindow=window-a"),
      "/",
    );
    assert.isNull(DesktopChildWindows.childWindowPathFromUrl("not a url"));
  });

  it("places a dragged-out window under the cursor, clamped to the work area", () => {
    const workArea = { x: 0, y: 25, width: 1440, height: 875 };
    assert.deepEqual(
      DesktopChildWindows.resolveNewChildWindowBounds({
        screenPoint: { x: 500, y: 300 },
        anchorBounds: null,
        workArea: { x: 0, y: 25, width: 2560, height: 1415 },
      }),
      { x: 420, y: 284, width: 900, height: 700 },
    );
    assert.deepEqual(
      DesktopChildWindows.resolveNewChildWindowBounds({
        screenPoint: { x: 1430, y: 890 },
        anchorBounds: null,
        workArea,
      }),
      { x: 540, y: 200, width: 900, height: 700 },
    );
  });

  it("cascades off the main window without a cursor point, else lets Electron center", () => {
    assert.deepEqual(
      DesktopChildWindows.resolveNewChildWindowBounds({
        screenPoint: undefined,
        anchorBounds: { x: 100, y: 80, width: 1100, height: 780 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      { x: 132, y: 112, width: 900, height: 700 },
    );
    assert.isNull(
      DesktopChildWindows.resolveNewChildWindowBounds({
        screenPoint: undefined,
        anchorBounds: null,
        workArea: null,
      }),
    );
  });

  it("drops restored bounds that no longer fit a connected display", () => {
    const bounds = { x: 1950, y: 40, width: 900, height: 700 };
    assert.isNull(
      DesktopChildWindows.resolveRestoredChildWindowBounds(bounds, [
        { x: 0, y: 0, width: 1920, height: 1080 },
      ]),
    );
    assert.deepEqual(
      DesktopChildWindows.resolveRestoredChildWindowBounds(bounds, [
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 1920, y: 0, width: 2560, height: 1440 },
      ]),
      bounds,
    );
  });
});
