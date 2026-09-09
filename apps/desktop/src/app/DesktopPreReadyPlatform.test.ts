import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  configureWebAuthnMock,
  setDesktopNameMock,
  mkdirSyncMock,
  writeFileSyncMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  configureWebAuthnMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

vi.mock("./DesktopWebAuthn.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./DesktopWebAuthn.ts")>()),
  configureDesktopWebAuthn: configureWebAuthnMock,
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
    getVersion: () => "0.0.41",
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: () => "{}",
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    configureWebAuthnMock.mockReset();
  });

  it("reads an explicit Electron command-line switch value", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: (switchName) => switchName === "password-store",
        getSwitchValue: (switchName) => {
          assert.equal(switchName, "password-store");
          return "basic";
        },
      },
      "password-store",
    );

    assert.equal(value, "basic");
  });

  it("treats valueless Electron command-line switches as absent", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: () => true,
        getSwitchValue: () => "",
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it("returns null for missing Electron command-line switches", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: () => false,
        getSwitchValue: () => {
          throw new Error("Unexpected switch value read.");
        },
      },
      "password-store",
    );

    assert.isNull(value);
  });

  for (const previousEntry of [undefined, 'Exec="/Applications/deleted-previous.AppImage" %U']) {
    it.effect(
      `prepares a ${previousEntry ? "stale" : "missing"} Linux desktop entry before startup yields`,
      () => {
        vi.stubEnv("VITE_DEV_SERVER_URL", "");
        vi.stubEnv("XDG_DATA_HOME", "/xdg");
        vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
        getSwitchValueMock.mockReturnValue("");
        let desktopName = "pathway.desktop";
        let desktopEntry = previousEntry;
        setDesktopNameMock.mockImplementation((name: string) => {
          desktopName = name;
        });
        writeFileSyncMock.mockImplementation((path: string, contents: string) => {
          if (path === "/xdg/applications/com.spiritdevs.Pathway.desktop") desktopEntry = contents;
        });

        return Effect.scoped(
          Effect.gen(function* () {
            const portalIdentity = Promise.resolve().then(() => ({ desktopName, desktopEntry }));
            yield* Layer.build(
              DesktopPreReadyPlatform.layer.pipe(
                Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
              ),
            );
            const identity = yield* Effect.promise(() => portalIdentity);
            assert.equal(identity.desktopName, "com.spiritdevs.Pathway.desktop");
            assert.include(identity.desktopEntry ?? "", 'Exec="/Applications/current.AppImage" %U');
            assert.include(identity.desktopEntry ?? "", "Name=Pathway (Alpha)");
            assert.include(identity.desktopEntry ?? "", "MimeType=x-scheme-handler/pathway;");
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
      },
    );
  }

  it.effect("keeps startup available when the early desktop entry cannot be written", () => {
    getSwitchValueMock.mockReturnValue("");
    mkdirSyncMock.mockImplementation(() => {
      throw new Error("read-only filesystem");
    });

    return DesktopPreReadyPlatform.make.pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.asVoid,
    );
  });

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@spiritdevs/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });
        configureWebAuthnMock.mockImplementation(() => {
          events.push("webauthn");
          return true;
        });

        const preReadyLayer = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
        );

        const clerkShapedLayer = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const runtimeLayer = clerkShapedLayer.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(preReadyLayer),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(runtimeLayer));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
          },
        });
        assert.deepEqual(new Set(events.slice(0, 2)), new Set(["pre-ready", "webauthn"]));
        assert.equal(events[2], "clerk");
        assert.deepEqual(configureWebAuthnMock.mock.calls, [["darwin"]]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
        assert.equal(setDesktopNameMock.mock.calls.length, 0);
      }),
  );
});
