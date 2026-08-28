import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_DEVELOPMENT_SERVER_PORT_RANGE,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("ClientSettings active-turn send mode", () => {
  it("defaults to steering and accepts either send mode", () => {
    expect(decodeClientSettings({}).activeTurnSendMode).toBe("steer");
    expect(decodeClientSettingsPatch({ activeTurnSendMode: "queue" }).activeTurnSendMode).toBe(
      "queue",
    );
    expect(decodeClientSettingsPatch({ activeTurnSendMode: "steer" }).activeTurnSendMode).toBe(
      "steer",
    );
  });

  it("rejects unsupported send modes", () => {
    expect(() => decodeClientSettings({ activeTurnSendMode: "restart" })).toThrow();
    expect(() => decodeClientSettingsPatch({ activeTurnSendMode: "auto" })).toThrow();
  });
});

describe("ClientSettings action palette", () => {
  it("migrates existing settings to the registry defaults and accepts persisted order", () => {
    expect(decodeClientSettings({}).actionPaletteSections).toEqual([]);
    expect(
      decodeClientSettingsPatch({
        actionPaletteSections: [
          { id: "usage", visible: false },
          { id: "future-section", visible: true },
        ],
      }).actionPaletteSections,
    ).toEqual([
      { id: "usage", visible: false },
      { id: "future-section", visible: true },
    ]);
  });
});

describe("ClientSettings development server ports", () => {
  it("defaults to the common development range and accepts a custom range", () => {
    expect(decodeClientSettings({}).developmentServerPortRange).toEqual(
      DEFAULT_DEVELOPMENT_SERVER_PORT_RANGE,
    );
    expect(
      decodeClientSettingsPatch({ developmentServerPortRange: { from: 4_000, to: 20_000 } })
        .developmentServerPortRange,
    ).toEqual({ from: 4_000, to: 20_000 });
  });

  it.each([
    { from: 0, to: 9_999 },
    { from: 3_000, to: 65_536 },
    { from: 9_999, to: 3_000 },
  ])("rejects an invalid range: $from-$to", (developmentServerPortRange) => {
    expect(() => decodeClientSettingsPatch({ developmentServerPortRange })).toThrow();
  });
});

describe("ClientSettings composer context strip", () => {
  it("defaults to draft-only and accepts a persistent strip preference", () => {
    expect(decodeClientSettings({}).persistComposerContextStrip).toBe(false);
    expect(
      decodeClientSettingsPatch({ persistComposerContextStrip: true }).persistComposerContextStrip,
    ).toBe(true);
  });
});

describe("ClientSettings primary navigation view order", () => {
  it("defaults to the movable view order and accepts a user preference", () => {
    expect(decodeClientSettings({}).primaryNavigationViewOrder).toEqual([
      "threads",
      "projects",
      "issues",
      "pull-requests",
      "calendar",
      "email",
      "contacts",
      "time-tracker",
    ]);
    expect(
      decodeClientSettingsPatch({ primaryNavigationViewOrder: ["email", "threads"] })
        .primaryNavigationViewOrder,
    ).toEqual(["email", "threads"]);
  });
});

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings sidebar", () => {
  it("defaults to the current sidebar with a three-day auto-settle threshold", () => {
    const settings = decodeClientSettings({});
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it("ignores a retired setting rather than failing to decode", () => {
    // The legacy sidebar is gone. A stored opt-in from before it was removed must decode as an
    // ordinary unknown key, not throw and take the whole settings document with it.
    expect(() => decodeClientSettings({ legacySidebarEnabled: true })).not.toThrow();
    expect(() => decodeClientSettingsPatch({ legacySidebarEnabled: true })).not.toThrow();
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("defaults context compaction to Sol at medium reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.contextCompactionModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });

  it("validates Claude's optional native auto-compaction window", () => {
    expect(
      decodeServerSettingsPatch({
        providers: { claudeAgent: { autoCompactWindow: "300000" } },
      }).providers?.claudeAgent?.autoCompactWindow,
    ).toBe("300000");
    expect(() =>
      decodeServerSettingsPatch({
        providers: { claudeAgent: { autoCompactWindow: "99999" } },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        providers: { claudeAgent: { autoCompactWindow: "1000001" } },
      }),
    ).toThrow();
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings Cursor legacy settings", () => {
  it("ignores obsolete Cursor CLI settings when reading server settings", () => {
    const decoded = decodeServerSettings({
      providers: {
        cursor: {
          enabled: true,
          binaryPath: "cursor-agent",
          apiEndpoint: "http://127.0.0.1:3774",
        },
      },
    });

    expect(decoded.providers.cursor.enabled).toBe(true);
    expect(decoded.providers.cursor).not.toHaveProperty("binaryPath");
    expect(decoded.providers.cursor).not.toHaveProperty("apiEndpoint");
  });

  it("ignores obsolete Cursor CLI settings in patches", () => {
    const patch = decodeServerSettingsPatch({
      providers: {
        cursor: {
          enabled: true,
          binaryPath: "cursor-agent",
          apiEndpoint: "http://127.0.0.1:3774",
        },
      },
    });

    expect(patch.providers?.cursor?.enabled).toBe(true);
    expect(patch.providers?.cursor).not.toHaveProperty("binaryPath");
    expect(patch.providers?.cursor).not.toHaveProperty("apiEndpoint");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it("defaults all style settings for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();
  });

  it("trims partial style updates", () => {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Prefer concise wording.  ",
      },
    });

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefer concise wording.",
    });
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("normalizes an environment name while preserving empty as automatic naming", () => {
    expect(decodeServerSettings({ environmentName: "  Studio  " }).environmentName).toBe("Studio");
    expect(decodeServerSettings({}).environmentName).toBe("");
    expect(decodeServerSettingsPatch({ environmentName: "  Laptop  " }).environmentName).toBe(
      "Laptop",
    );
  });

  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});

describe("ServerSettingsPatch.issueEnrichmentModelSelection", () => {
  it("decodes what the Enrichment settings page sends", () => {
    // The page hands `createModelSelection(...)` straight to `updateSettings`, so the patch has to
    // accept a whole selection — including the option-only shape the traits picker writes, which
    // omits `instanceId` and `model` entirely.
    const whole = decodeServerSettingsPatch({
      issueEnrichmentModelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });

    expect(whole.issueEnrichmentModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    // Independent of the text-generation key: naming one must not name the other.
    expect(whole.textGenerationModelSelection).toBeUndefined();

    expect(
      decodeServerSettingsPatch({ issueEnrichmentModelSelection: { model: "gpt-5.6-luna" } })
        .issueEnrichmentModelSelection,
    ).toEqual({ model: "gpt-5.6-luna" });
    expect(decodeServerSettingsPatch({}).issueEnrichmentModelSelection).toBeUndefined();
  });

  it("defaults to the text generation selection and survives a full re-decode", () => {
    const settings = decodeServerSettings({});
    expect(settings.issueEnrichmentModelSelection).toEqual(settings.textGenerationModelSelection);
    expect(
      decodeServerSettings(encodeServerSettings(settings)).issueEnrichmentModelSelection,
    ).toEqual(DEFAULT_SERVER_SETTINGS.issueEnrichmentModelSelection);
  });
});

describe("ServerSettingsPatch.issueAutomation", () => {
  it("defaults to an inert, bounded workflow", () => {
    const automation = decodeServerSettings({}).issueAutomation;
    expect(automation.routingRules).toEqual([]);
    expect(automation.auditRules).toEqual([]);
    expect(automation.reviewWorkers).toEqual([]);
    expect(automation.fallbackModelSelection).toBeNull();
    expect(automation.statusTransitions).toEqual({
      workStartedStatusId: null,
      workFinishedStatusId: null,
      auditPassedStatusId: null,
      auditChangesRequestedStatusId: null,
    });
    expect(automation.maxRemediationCycles).toBe(3);
  });

  it("round-trips ordered worker rules, several auditors, and custom status ids", () => {
    const current = decodeServerSettings({});
    const issueAutomation = {
      ...current.issueAutomation,
      routingRules: [
        {
          id: "ui",
          name: "UI work",
          condition: "Frontend changes",
          modelSelection: current.textGenerationModelSelection,
        },
      ],
      auditRules: [
        {
          id: "implementation",
          name: "Implementation review",
          condition: "All completed work",
          auditors: [
            { id: "primary", modelSelection: current.textGenerationModelSelection },
            {
              id: "second-opinion",
              modelSelection: { ...current.textGenerationModelSelection, model: "second-opinion" },
            },
          ],
        },
      ],
      reviewWorkers: [
        {
          id: "review-fixer",
          modelSelection: { ...current.textGenerationModelSelection, model: "review-fixer" },
        },
      ],
      statusTransitions: {
        workStartedStatusId: "custom-building",
        workFinishedStatusId: "custom-review",
        auditPassedStatusId: "custom-shipped",
        auditChangesRequestedStatusId: "custom-building",
      },
    };
    const patch = decodeServerSettingsPatch({ issueAutomation });
    expect(patch.issueAutomation).toEqual(issueAutomation);
    expect(
      decodeServerSettings(encodeServerSettings({ ...current, issueAutomation })).issueAutomation,
    ).toEqual(issueAutomation);
  });
});
