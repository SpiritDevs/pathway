import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

vi.mock("electron", () => ({}));

const { computerUseEnabled } = await import("./DesktopComputerHost.ts");

const enabledFor = (platform: NodeJS.Platform, env: Record<string, string>) =>
  computerUseEnabled.pipe(
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

describe("computerUseEnabled", () => {
  it.effect("stays off unless PATHWAY_COMPUTER_USE opts in", () =>
    Effect.gen(function* () {
      expect(yield* enabledFor("darwin", {})).toBe(false);
      expect(yield* enabledFor("darwin", { PATHWAY_COMPUTER_USE: "0" })).toBe(false);
      expect(yield* enabledFor("darwin", { PATHWAY_COMPUTER_USE: "maybe" })).toBe(false);
      expect(yield* enabledFor("darwin", { PATHWAY_COMPUTER_USE: "1" })).toBe(true);
    }),
  );

  it.effect("stays off outside macOS even when opted in", () =>
    Effect.gen(function* () {
      expect(yield* enabledFor("linux", { PATHWAY_COMPUTER_USE: "1" })).toBe(false);
      expect(yield* enabledFor("win32", { PATHWAY_COMPUTER_USE: "1" })).toBe(false);
    }),
  );
});
