import * as Schema from "effect/Schema";

export const DictationModelId = Schema.Literals([
  "whisper-base",
  "whisper-small",
  "whisper-turbo",
  "qwen-cleanup",
]);
export type DictationModelId = typeof DictationModelId.Type;
export const DictationShortcut = Schema.Literals(["fn", "right-control", "right-option", "F8"]);
export type DictationShortcut = typeof DictationShortcut.Type;
export const DictationPreferences = Schema.Struct({
  enabled: Schema.Boolean,
  setupComplete: Schema.Boolean,
  showIdleBar: Schema.Boolean,
  microphoneId: Schema.String,
  shortcut: DictationShortcut,
  language: Schema.String,
  speechModel: DictationModelId,
  cleanupEnabled: Schema.Boolean,
  saveHistory: Schema.Boolean,
  retentionDays: Schema.Number,
  idleUnloadMinutes: Schema.Number,
});
export type DictationPreferences = typeof DictationPreferences.Type;

export const DictationDictionaryTerm = Schema.Struct({
  id: Schema.String,
  spelling: Schema.String,
  aliases: Schema.Array(Schema.String),
});
export const DictationDictionaryList = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  terms: Schema.Array(DictationDictionaryTerm),
});
export type DictationDictionaryList = typeof DictationDictionaryList.Type;

export function dictationDictionaryError(lists: readonly DictationDictionaryList[]): string | null {
  if (lists.length > 32) return "Use at most 32 dictionary lists.";
  const ids = new Set<string>();
  const spellings = new Map<string, string>();
  let count = 0;
  for (const list of lists) {
    if (!list.id || ids.has(list.id) || !list.name.trim() || list.name.length > 100)
      return "Each list needs a unique ID and a name of at most 100 characters.";
    ids.add(list.id);
    for (const term of list.terms) {
      if (++count > 500) return "Use at most 500 dictionary terms.";
      if (
        !term.id ||
        ids.has(term.id) ||
        !term.spelling.trim() ||
        term.spelling.length > 256 ||
        term.aliases.length > 8
      )
        return "Each term needs a unique ID, a spelling of at most 256 characters, and at most eight corrections.";
      ids.add(term.id);
      for (const phrase of [term.spelling, ...term.aliases]) {
        if (!phrase.trim() || phrase.length > 256)
          return "Corrections must contain between 1 and 256 characters.";
        const key = phrase.trim().normalize("NFKC").toLocaleLowerCase("und");
        const previous = spellings.get(key);
        if (previous !== undefined && previous !== term.spelling)
          return `The phrase “${phrase}” maps to more than one spelling.`;
        spellings.set(key, term.spelling);
      }
    }
  }
  return null;
}
export const DictationHistoryEntry = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  originalText: Schema.String,
  text: Schema.String,
  durationMs: Schema.Number,
  modelId: DictationModelId,
  language: Schema.String,
  cleanup: Schema.Literals(["applied", "disabled", "unavailable"]),
  delivery: Schema.Literals(["inserted", "unconfirmed", "manual", "test"]),
});
export type DictationHistoryEntry = typeof DictationHistoryEntry.Type;
export const DictationModelState = Schema.Struct({
  id: DictationModelId,
  name: Schema.String,
  kind: Schema.Literals(["speech", "cleanup"]),
  bytes: Schema.Number,
  status: Schema.Literals(["missing", "downloading", "verifying", "installed", "error"]),
  downloadedBytes: Schema.Number,
  loaded: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type DictationModelState = typeof DictationModelState.Type;
export const DictationMicrophone = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isDefault: Schema.Boolean,
});
export type DictationMicrophone = typeof DictationMicrophone.Type;
export const DictationState = Schema.Struct({
  supported: Schema.Boolean,
  platform: Schema.String,
  authenticated: Schema.Boolean,
  accountId: Schema.NullOr(Schema.String),
  preferences: DictationPreferences,
  models: Schema.Array(DictationModelState),
  microphones: Schema.Array(DictationMicrophone),
  microphonePermission: Schema.Literals(["unknown", "granted", "denied"]),
  accessibilityPermission: Schema.Literals(["unknown", "granted", "denied"]),
  nativeAvailable: Schema.Boolean,
  phase: Schema.Literals([
    "disabled",
    "idle",
    "starting",
    "recording",
    "processing",
    "result",
    "error",
  ]),
  mode: Schema.Literals(["hold", "locked", "test"]),
  durationMs: Schema.Number,
  level: Schema.Number,
  result: Schema.NullOr(DictationHistoryEntry),
  error: Schema.NullOr(Schema.String),
  dictionary: Schema.Array(DictationDictionaryList),
  dictionaryConnected: Schema.Boolean,
});
export type DictationState = typeof DictationState.Type;

export const DictationCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("preferences"), preferences: DictationPreferences }),
  Schema.Struct({ type: Schema.Literal("account"), accountId: Schema.NullOr(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("dictionary"),
    lists: Schema.Array(DictationDictionaryList),
    connected: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("download"), modelId: DictationModelId }),
  Schema.Struct({ type: Schema.Literal("cancel-download"), modelId: DictationModelId }),
  Schema.Struct({ type: Schema.Literal("remove-model"), modelId: DictationModelId }),
  Schema.Struct({ type: Schema.Literal("start"), mode: Schema.Literals(["locked", "test"]) }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  Schema.Struct({ type: Schema.Literal("cancel") }),
  Schema.Struct({ type: Schema.Literal("dismiss") }),
  Schema.Struct({
    type: Schema.Literal("permissions"),
    action: Schema.optional(Schema.Literals(["microphone", "accessibility", "refresh"])),
  }),
  Schema.Struct({ type: Schema.Literal("refresh-devices") }),
  Schema.Struct({ type: Schema.Literal("copy"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("delete-history"), id: Schema.NullOr(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("open"),
    page: Schema.Literals(["models", "history", "dictionary", "settings"]),
  }),
]);
export type DictationCommand = typeof DictationCommand.Type;

export interface DictationBridge {
  getState(): Promise<DictationState>;
  execute(command: DictationCommand): Promise<DictationState>;
  listHistory(): Promise<readonly DictationHistoryEntry[]>;
  onState(listener: (state: DictationState) => void): () => void;
  onNavigate?(
    listener: (page: "models" | "history" | "dictionary" | "settings") => void,
  ): () => void;
}

export const defaultDictationPreferences = (platform: string): DictationPreferences => ({
  enabled: false,
  setupComplete: false,
  showIdleBar: true,
  microphoneId: "default",
  shortcut: platform === "darwin" ? "fn" : "right-control",
  language: "auto",
  speechModel: "whisper-turbo",
  cleanupEnabled: true,
  saveHistory: true,
  retentionDays: 30,
  idleUnloadMinutes: 5,
});
