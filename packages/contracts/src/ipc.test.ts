import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopPreviewAdoptPopupInputSchema,
  DesktopPreviewPopupRequestSchema,
  DesktopPreviewPresentNativeTabInputSchema,
} from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("desktop preview popup schemas", () => {
  it("decodes the bounded popup rendezvous payloads", () => {
    expect(
      Schema.decodeUnknownSync(DesktopPreviewPopupRequestSchema)({
        sourceRuntimeTabId: "runtime-source",
        popupId: "popup-1",
        url: "about:blank",
        disposition: "foreground-tab",
        frameName: "editor",
      }),
    ).toMatchObject({ popupId: "popup-1", disposition: "foreground-tab" });
    expect(
      Schema.decodeUnknownSync(DesktopPreviewAdoptPopupInputSchema)({
        popupId: "popup-1",
        runtimeTabId: "runtime-popup",
      }),
    ).toEqual({ popupId: "popup-1", runtimeTabId: "runtime-popup" });
    expect(
      Schema.decodeUnknownSync(DesktopPreviewPresentNativeTabInputSchema)({
        runtimeTabId: "runtime-popup",
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      }).bounds,
    ).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });

  it("rejects malformed popup dispositions and presentation bounds", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesktopPreviewPopupRequestSchema)({
        sourceRuntimeTabId: "runtime-source",
        popupId: "popup-1",
        url: "about:blank",
        disposition: "popup",
        frameName: "",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(DesktopPreviewPresentNativeTabInputSchema)({
        runtimeTabId: "runtime-popup",
        bounds: { x: 0, y: 0, width: 0, height: 600 },
      }),
    ).toThrow();
  });
});
