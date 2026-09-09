import { it as effectIt } from "@effect/vitest";
import { PREVIEW_AUTOMATION_RECORDING_CHUNK_MAX_BYTES } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

const isPreviewAutofillError = Schema.is(PreviewManager.PreviewAutofillError);

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect(
    "passes native popup adoption, presentation, and discard through the validated bridge",
    () =>
      Effect.gen(function* () {
        const adoptPopup = vi.fn(() => Effect.void);
        const presentNativeTab = vi.fn(() => Effect.void);
        const discardPopup = vi.fn(() => Effect.void);
        const manager = {
          adoptPopup,
          presentNativeTab,
          discardPopup,
        } as unknown as PreviewManager.PreviewManager["Service"];
        yield* PreviewIpc.adoptPopup
          .handler({ popupId: "popup-1", runtimeTabId: "child-1" })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
        const bounds = { x: 5, y: 10, width: 600, height: 400 };
        yield* PreviewIpc.presentNativeTab
          .handler({ runtimeTabId: "child-1", bounds })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
        yield* PreviewIpc.presentNativeTab
          .handler({ runtimeTabId: "child-1", bounds: null })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
        yield* PreviewIpc.discardPopup
          .handler({ popupId: "popup-1" })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager));
        expect(adoptPopup).toHaveBeenCalledWith("popup-1", "child-1");
        expect(presentNativeTab).toHaveBeenCalledWith("child-1", bounds);
        expect(presentNativeTab).toHaveBeenCalledWith("child-1", null);
        expect(discardPopup).toHaveBeenCalledWith("popup-1");
      }),
  );

  effectIt.effect("rejects malformed popup requests before resolving the preview service", () =>
    Effect.gen(function* () {
      const requests = [
        PreviewIpc.adoptPopup.handler({ popupId: "", runtimeTabId: "child-1" }),
        PreviewIpc.presentNativeTab.handler({
          runtimeTabId: "child-1",
          bounds: { x: 0, y: 0, width: 0, height: 400 },
        }),
        PreviewIpc.discardPopup.handler({ popupId: "" }),
      ];
      for (const request of requests) {
        const exit = yield* request.pipe(
          Effect.provideService(PreviewManager.PreviewManager, null as never),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) continue;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
      }
    }),
  );

  effectIt.effect("discards malformed credential payloads without retaining secret values", () =>
    Effect.map(
      PreviewIpc.autofillLogin
        .handler({
          tabId: "tab-1",
          input: { origin: null, username: "private-user", password: "private-password" },
        })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && isPreviewAutofillError(error.value)).toBe(true);
        expect(JSON.stringify(exit)).not.toContain("private-password");
        expect(JSON.stringify(exit)).not.toContain("private-user");
      },
    ),
  );

  effectIt.effect("bounds recording reads before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.readRecording
        .handler({
          path: "/tmp/browser-recording.webm",
          offset: 0,
          length: PREVIEW_AUTOMATION_RECORDING_CHUNK_MAX_BYTES + 1,
        })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
      },
    ),
  );
});
