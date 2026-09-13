import { useAuth } from "@clerk/react";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MicIcon } from "lucide-react";
import { useDictation } from "../../dictation/useDictation";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Notice } from "./DictationControls";
import { DictationDictionary } from "./DictationDictionary";
import { DictationHistory } from "./DictationHistory";
import { DictationModels } from "./DictationModels";
import { DictationSettings } from "./DictationSettings";
import { DictationSetup } from "./DictationSetup";

export type DictationPageName = "setup" | "models" | "history" | "dictionary" | "settings";
const titles = {
  setup: "Set up dictation",
  models: "Models",
  history: "History",
  dictionary: "Dictionary",
  settings: "Settings",
};

export function DictationPage({ page }: { page: DictationPageName }) {
  const { state, error, bridge, execute, updatePreferences, refresh } = useDictation();
  const navigate = useNavigate();
  const { userId } = useAuth();
  useEffect(() => {
    if (!bridge || state?.supported === false)
      void navigate({ to: "/settings/general", replace: true });
    else if (state && !state.preferences.setupComplete && page !== "setup")
      void navigate({ to: "/settings/dictation", replace: true });
    else if (state?.preferences.setupComplete && page === "setup")
      void navigate({ to: "/settings/dictation/settings", replace: true });
  }, [bridge, navigate, page, state?.preferences.setupComplete, state?.supported]);
  const content = () => {
    if (!state || !bridge || !execute || !updatePreferences)
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Connecting to desktop dictation…
        </p>
      );
    if (!state.supported) return null;
    if (!state.authenticated || state.accountId !== userId)
      return <Notice>Sign in to your Pathway account to use dictation.</Notice>;
    const props = { state, execute, updatePreferences };
    if (!state.preferences.setupComplete)
      return <DictationSetup key={state.accountId} {...props} error={error} />;
    switch (page) {
      case "models":
        return <DictationModels {...props} />;
      case "history":
        return <DictationHistory key={state.accountId} {...props} bridge={bridge} />;
      case "dictionary":
        return <DictationDictionary key={state.accountId} {...props} />;
      default:
        return <DictationSettings {...props} />;
    }
  };
  return (
    <SettingsPageContainer className="max-w-3xl gap-8">
      {state?.preferences.setupComplete && (
        <header className="px-3 sm:px-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <MicIcon className="size-3.5" />
            Dictation
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{titles[page]}</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            {page === "dictionary"
              ? "Your words, across your desktops."
              : "On this desktop, wherever your agents run."}
          </p>
        </header>
      )}
      {state?.preferences.setupComplete && (error || state.error) && (
        <Notice error>
          {error ?? state?.error}
          <Button size="sm" variant="ghost" className="ml-2" onClick={() => void refresh?.()}>
            Refresh status
          </Button>
        </Notice>
      )}
      {content()}
    </SettingsPageContainer>
  );
}
