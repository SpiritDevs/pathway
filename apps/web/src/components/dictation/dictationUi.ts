import {
  dictationDictionaryError,
  type DictationDictionaryList,
  type DictationState,
} from "@spiritdevs/contracts/dictation";

export function dictationReadiness(state: DictationState) {
  const reasons: string[] = [];
  if (!state.supported)
    reasons.push("Dictation needs an Apple Silicon Mac or Windows x64 desktop.");
  if (!state.authenticated) reasons.push("Sign in to Pathway to use dictation.");
  if (!state.nativeAvailable)
    reasons.push("The dictation engine is unavailable. Restart Pathway to try again.");
  if (state.microphonePermission !== "granted") reasons.push("Allow microphone access.");
  if (state.platform === "darwin" && state.accessibilityPermission !== "granted")
    reasons.push("Allow accessibility access for the shortcut and text insertion.");
  if (
    !state.models.some(
      (model) =>
        model.id === state.preferences.speechModel &&
        model.kind === "speech" &&
        model.status === "installed",
    )
  ) {
    reasons.push("Download and select a speech model.");
  }
  if (
    state.preferences.microphoneId !== "default" &&
    !state.microphones.some((device) => device.id === state.preferences.microphoneId)
  ) {
    reasons.push("Your selected microphone is disconnected. Choose an available input.");
  }
  return reasons;
}

export function formatBytes(bytes: number) {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(2)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function normalizeDictionary(
  lists: readonly DictationDictionaryList[],
): readonly DictationDictionaryList[] {
  return lists.map((list) => ({
    ...list,
    name: list.name.trim(),
    terms: list.terms.map((term) => ({
      ...term,
      spelling: term.spelling.trim(),
      aliases: [...new Set(term.aliases.map((alias) => alias.trim()).filter(Boolean))],
    })),
  }));
}

/** Normalize editor whitespace before applying the same rules as cloud saves. */
export function dictionaryValidation(lists: readonly DictationDictionaryList[]): string | null {
  return dictationDictionaryError(normalizeDictionary(lists));
}

export function dictationSettingsPathVisible(path: string, availability: string) {
  if (!path.startsWith("/settings/dictation")) return true;
  if (availability === "unavailable") return false;
  return availability === "setup" ? path === "/settings/dictation" : path !== "/settings/dictation";
}
