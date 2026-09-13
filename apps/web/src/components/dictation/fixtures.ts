import {
  defaultDictationPreferences,
  type DictationHistoryEntry,
  type DictationState,
} from "@spiritdevs/contracts/dictation";

/** Isolated UI fixtures. These describe presentation, never evidence of native inference. */
export const dictationFixtureNames = [
  "ready",
  "setup",
  "setup-access-ready",
  "setup-models",
  "setup-test",
  "setup-test-recording",
  "setup-test-result",
  "setup-windows",
  "downloading",
  "verifying",
  "download-error",
  "permissions-denied",
  "models-missing",
  "offline",
  "disabled",
  "recording-hold",
  "recording-locked",
  "processing",
  "result",
  "unconfirmed",
  "cleanup-unavailable",
  "microphone-test",
  "windows",
] as const;
export type DictationFixtureName = (typeof dictationFixtureNames)[number];

export const dictationHistoryFixtures: readonly DictationHistoryEntry[] = [
  {
    id: "history-1",
    createdAt: "2026-09-12T09:42:00Z",
    originalText:
      "Can you send the, um, the updated proposal to Maya before three? Actually, make that four.",
    text: "Can you send the updated proposal to Maya before four?",
    durationMs: 12400,
    modelId: "whisper-turbo",
    language: "en",
    cleanup: "applied",
    delivery: "manual",
  },
  {
    id: "history-2",
    createdAt: "2026-09-12T09:35:00Z",
    originalText:
      "The Pathway launch review is ready. I added the new onboarding screens and updated the release notes.",
    text: "The Pathway launch review is ready. I added the new onboarding screens and updated the release notes.",
    durationMs: 18500,
    modelId: "whisper-turbo",
    language: "en",
    cleanup: "applied",
    delivery: "inserted",
  },
  {
    id: "history-3",
    createdAt: "2026-09-12T09:21:00Z",
    originalText: "Merci pour la mise à jour. Je vais regarder les maquettes cet après-midi.",
    text: "Merci pour la mise à jour. Je vais regarder les maquettes cet après-midi.",
    durationMs: 8200,
    modelId: "whisper-turbo",
    language: "fr",
    cleanup: "applied",
    delivery: "inserted",
  },
  {
    id: "history-4",
    createdAt: "2026-09-11T16:05:00Z",
    originalText: "Please move our design sync to Thursday at ten.",
    text: "Please move our design sync to Thursday at ten.",
    durationMs: 6100,
    modelId: "whisper-turbo",
    language: "en",
    cleanup: "disabled",
    delivery: "inserted",
  },
  {
    id: "history-5",
    createdAt: "2026-09-11T15:22:00Z",
    originalText: "Note for tomorrow: check the microphone selection on Windows.",
    text: "Note for tomorrow: check the microphone selection on Windows.",
    durationMs: 7400,
    modelId: "whisper-small",
    language: "en",
    cleanup: "unavailable",
    delivery: "manual",
  },
];

export function makeDictationFixture(name: DictationFixtureName = "ready"): DictationState {
  const state: DictationState = {
    supported: true,
    platform: name === "windows" || name === "setup-windows" ? "win32" : "darwin",
    authenticated: true,
    accountId: "fixture-account",
    preferences: {
      ...defaultDictationPreferences(
        name === "windows" || name === "setup-windows" ? "win32" : "darwin",
      ),
      setupComplete: true,
      enabled: true,
    },
    models: [
      {
        id: "whisper-base",
        name: "Whisper Base",
        kind: "speech",
        bytes: 148_000_000,
        status: "missing",
        downloadedBytes: 0,
        loaded: false,
        error: null,
      },
      {
        id: "whisper-small",
        name: "Whisper Small",
        kind: "speech",
        bytes: 488_000_000,
        status: "installed",
        downloadedBytes: 488_000_000,
        loaded: false,
        error: null,
      },
      {
        id: "whisper-turbo",
        name: "Whisper large-v3-turbo",
        kind: "speech",
        bytes: 1_620_000_000,
        status: "installed",
        downloadedBytes: 1_620_000_000,
        loaded: false,
        error: null,
      },
      {
        id: "qwen-cleanup",
        name: "Qwen3-4B-Instruct-2507",
        kind: "cleanup",
        bytes: 2_500_000_000,
        status: "installed",
        downloadedBytes: 2_500_000_000,
        loaded: false,
        error: null,
      },
    ],
    microphones: [
      { id: "built-in", name: "MacBook Pro Microphone", isDefault: true },
      { id: "usb", name: "Studio microphone", isDefault: false },
    ],
    microphonePermission: "granted",
    accessibilityPermission: "granted",
    nativeAvailable: true,
    phase: "idle",
    mode: "locked",
    durationMs: 0,
    level: 0,
    result: null,
    error: null,
    dictionaryConnected: true,
    dictionary: [
      {
        id: "list-work",
        name: "Work",
        terms: [
          { id: "term-pathway", spelling: "Pathway", aliases: ["path way"] },
          {
            id: "term-spirit",
            spelling: "SpiritDevs",
            aliases: ["spirit devs", "spirit developers"],
          },
        ],
      },
      {
        id: "list-people",
        name: "People",
        terms: [{ id: "term-maya", spelling: "Maya Chen", aliases: ["my a chen"] }],
      },
    ],
  };
  if (
    [
      "setup-access-ready",
      "setup-models",
      "setup-test",
      "setup-test-recording",
      "setup-test-result",
      "setup-windows",
    ].includes(name)
  ) {
    const permissionsPending = name === "setup-windows";
    const modelsPending = ["setup-access-ready", "setup-models", "setup-windows"].includes(name);
    return {
      ...state,
      preferences: { ...state.preferences, enabled: false, setupComplete: false },
      phase:
        name === "setup-test-recording"
          ? "recording"
          : name === "setup-test-result"
            ? "result"
            : "disabled",
      mode: "test",
      durationMs: name === "setup-test-recording" ? 6000 : 0,
      level: name === "setup-test-recording" ? 0.65 : 0,
      result:
        name === "setup-test-result" ? { ...dictationHistoryFixtures[0]!, delivery: "test" } : null,
      microphonePermission: permissionsPending ? "unknown" : "granted",
      models: modelsPending
        ? state.models.map((model) => ({ ...model, status: "missing", downloadedBytes: 0 }))
        : state.models,
    };
  }
  if (
    ["setup", "downloading", "verifying", "download-error", "permissions-denied"].includes(name)
  ) {
    return {
      ...state,
      preferences: { ...state.preferences, setupComplete: false, enabled: false },
      phase: "disabled",
      microphonePermission:
        name === "permissions-denied" ? "denied" : name === "setup" ? "unknown" : "granted",
      accessibilityPermission:
        name === "permissions-denied" ? "denied" : name === "setup" ? "unknown" : "granted",
      models: state.models.map((model) => ({
        ...model,
        status:
          name === "downloading"
            ? "downloading"
            : name === "verifying"
              ? "verifying"
              : name === "download-error"
                ? "error"
                : "missing",
        downloadedBytes:
          name === "downloading" ? model.bytes * 0.43 : name === "verifying" ? model.bytes : 0,
        error:
          name === "download-error"
            ? "The download was interrupted. Check your connection and retry."
            : null,
      })),
    };
  }
  if (name === "models-missing")
    return {
      ...state,
      models: state.models.map((model) => ({ ...model, status: "missing", downloadedBytes: 0 })),
    };
  if (name === "offline") return { ...state, dictionaryConnected: false };
  if (name === "disabled")
    return { ...state, preferences: { ...state.preferences, enabled: false }, phase: "disabled" };
  if (name === "recording-hold" || name === "recording-locked")
    return {
      ...state,
      phase: "recording",
      mode: name === "recording-hold" ? "hold" : "locked",
      durationMs: 23_000,
      level: 0.7,
    };
  if (name === "processing") return { ...state, phase: "processing", durationMs: 23_000 };
  if (["result", "unconfirmed", "cleanup-unavailable", "microphone-test"].includes(name))
    return {
      ...state,
      phase: "result",
      mode: name === "microphone-test" ? "test" : "locked",
      result: {
        ...dictationHistoryFixtures[0]!,
        delivery:
          name === "unconfirmed" ? "unconfirmed" : name === "microphone-test" ? "test" : "manual",
        cleanup: name === "cleanup-unavailable" ? "unavailable" : "applied",
      },
    };
  return state;
}
