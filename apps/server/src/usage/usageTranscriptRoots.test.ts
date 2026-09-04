import { describe, it, expect } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { usageTranscriptRoots } from "./usageTranscriptRoots.ts";

describe("configured transcript roots", () => {
  it.effect("includes archives, instance homes and environment overrides once", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
          },
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: false,
          },
          [ProviderInstanceId.make("work")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: "/work", shadowHomePath: "/shadow" },
          },
          [ProviderInstanceId.make("duplicate")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: "/work" },
          },
          [ProviderInstanceId.make("personal")]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [{ name: "CODEX_HOME", value: "/personal", sensitive: false }],
          },
          [ProviderInstanceId.make("claude_work")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: "~/claude-work", sensitive: false }],
          },
        },
      };
      expect(usageTranscriptRoots(settings, { HOME: "/home/test" }, path)).toEqual([
        { provider: "codex", dir: "/work/sessions" },
        { provider: "codex", dir: "/work/archived_sessions" },
        { provider: "codex", dir: "/personal/sessions" },
        { provider: "codex", dir: "/personal/archived_sessions" },
        { provider: "claude", dir: "/home/test/claude-work/projects" },
      ]);
    }).pipe(Effect.provide(Path.layer)),
  );
});
