import { EyeIcon, LanguagesIcon } from "lucide-react";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import {
  Choice,
  MicrophoneControls,
  PermissionControls,
  ReadinessNotice,
  ShortcutControls,
  type DictationActions,
} from "./DictationControls";
import { dictationReadiness } from "./dictationUi";

const languageCodes = [
  "en",
  "zh",
  "de",
  "es",
  "ru",
  "ko",
  "fr",
  "ja",
  "pt",
  "tr",
  "pl",
  "ca",
  "nl",
  "ar",
  "sv",
  "it",
  "id",
  "hi",
  "fi",
  "vi",
  "he",
  "uk",
  "el",
  "ms",
  "cs",
  "ro",
  "da",
  "hu",
  "ta",
  "no",
  "th",
  "ur",
  "hr",
  "bg",
  "lt",
  "la",
  "mi",
  "ml",
  "cy",
  "sk",
  "te",
  "fa",
  "lv",
  "bn",
  "sr",
  "az",
  "sl",
  "kn",
  "et",
  "mk",
  "br",
  "eu",
  "is",
  "hy",
  "ne",
  "mn",
  "bs",
  "kk",
  "sq",
  "sw",
  "gl",
  "mr",
  "pa",
  "si",
  "km",
  "sn",
  "yo",
  "so",
  "af",
  "oc",
  "ka",
  "be",
  "tg",
  "sd",
  "gu",
  "am",
  "yi",
  "lo",
  "uz",
  "fo",
  "ht",
  "ps",
  "tk",
  "nn",
  "mt",
  "sa",
  "lb",
  "my",
  "bo",
  "tl",
  "mg",
  "as",
  "tt",
  "haw",
  "ln",
  "ha",
  "ba",
  "jw",
  "su",
  "yue",
];
const names = new Intl.DisplayNames(["en"], { type: "language" });
const languages = [
  { value: "auto", label: "Detect automatically" },
  ...languageCodes
    .map((value) => ({ value, label: names.of(value) ?? value }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

export function DictationSettings(props: DictationActions) {
  const { state, updatePreferences } = props;
  const preferences = state.preferences;
  const ready = dictationReadiness(state).length === 0;
  return (
    <>
      <SettingsSection title="Dictation on this desktop" id="dictation-enabled">
        <SettingsRow
          title="Enable dictation"
          description="Use your shortcut and the dictation bar in any app. Pathway keeps running when you close its main window."
          control={
            <Switch
              aria-label="Enable dictation"
              checked={preferences.enabled}
              disabled={!preferences.enabled && !ready}
              onCheckedChange={(enabled) => void updatePreferences({ enabled })}
            />
          }
        />
        {!preferences.enabled && (
          <p className="px-4 text-xs leading-relaxed text-muted-foreground">
            Dictation is off. Your downloaded models, dictionary, and history are kept.
          </p>
        )}
      </SettingsSection>
      <ReadinessNotice state={state} />
      <MicrophoneControls {...props} />
      <ShortcutControls {...props} />
      <SettingsSection
        title="Language"
        id="dictation-language"
        icon={<LanguagesIcon className="size-4" />}
      >
        <SettingsRow
          title="Spoken language"
          description="Recognition and cleanup preserve your spoken language."
          control={
            <Choice
              label="Spoken language"
              value={preferences.language}
              options={
                languages.some((language) => language.value === preferences.language)
                  ? languages
                  : [...languages, { value: preferences.language, label: preferences.language }]
              }
              onChange={(language) => void updatePreferences({ language })}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Bar and memory"
        id="dictation-bar"
        icon={<EyeIcon className="size-4" />}
      >
        <SettingsRow
          title="Show idle bar"
          description="Keep the small bar at the bottom of your screen. Recording and processing remain visible when this is off."
          control={
            <Switch
              aria-label="Show idle bar"
              checked={preferences.showIdleBar}
              onCheckedChange={(showIdleBar) => void updatePreferences({ showIdleBar })}
            />
          }
        />
        <SettingsRow
          title="Unload models after"
          description="Release model memory after dictation is idle. Downloaded files stay on this desktop."
          control={
            <Choice
              label="Model idle lifetime"
              value={String(preferences.idleUnloadMinutes)}
              options={[
                { value: "0", label: "After every dictation" },
                { value: "5", label: "5 minutes" },
                { value: "15", label: "15 minutes" },
                { value: "-1", label: "Until Pathway quits" },
              ]}
              onChange={(value) => void updatePreferences({ idleUnloadMinutes: Number(value) })}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="History" id="dictation-retention">
        <SettingsRow
          title="Save dictation history"
          description="Keep original and cleaned text for your account on this desktop. Turning this off stops future saving."
          control={
            <Switch
              aria-label="Save dictation history"
              checked={preferences.saveHistory}
              onCheckedChange={(saveHistory) => void updatePreferences({ saveHistory })}
            />
          }
        />
        <SettingsRow
          title="Keep history for"
          description="Older entries are deleted automatically. You can delete individual entries or all history from History."
          control={
            <Choice
              label="History retention"
              value={String(preferences.retentionDays)}
              options={[
                { value: "1", label: "1 day" },
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
                { value: "365", label: "1 year" },
                { value: "0", label: "Until I delete it" },
              ]}
              onChange={(value) => void updatePreferences({ retentionDays: Number(value) })}
            />
          }
        />
      </SettingsSection>
      <PermissionControls {...props} />
    </>
  );
}
