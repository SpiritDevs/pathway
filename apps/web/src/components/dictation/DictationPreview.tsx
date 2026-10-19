import { useEffect, useMemo, useState } from "react";
import type {
  DictationBridge,
  DictationCommand,
  DictationState,
} from "@spiritdevs/contracts/dictation";
import widgetModuleUrl from "../../../../desktop/src/dictation/widgetHtml.ts?url";
import { DictationBridgeContext, useDictation } from "../../dictation/useDictation";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { Choice, Notice } from "./DictationControls";
import { DictationModels } from "./DictationModels";
import { DictationHistory } from "./DictationHistory";
import { DictationDictionary } from "./DictationDictionary";
import { DictationSettings } from "./DictationSettings";
import { DictationSetupDialog } from "./DictationSetupDialog";
import { Button } from "../ui/button";
import { DictationSetup } from "./DictationSetup";
import {
  dictationFixtureNames,
  dictationHistoryFixtures,
  makeDictationFixture,
  type DictationFixtureName,
} from "./fixtures";

function fixtureBridge(initial: DictationState): DictationBridge {
  let state = initial;
  let history = dictationHistoryFixtures;
  const listeners = new Set<(state: DictationState) => void>();
  return {
    getState: async () => state,
    listHistory: async () => history,
    onState: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    execute: async (command: DictationCommand) => {
      if (command.type === "preferences") state = { ...state, preferences: command.preferences };
      else if (command.type === "dictionary") state = { ...state, dictionary: command.lists };
      else if (command.type === "delete-history")
        history = history.filter((entry) => command.id !== null && entry.id !== command.id);
      else if (command.type === "permissions" && command.action === "refresh") return state;
      else if (["start", "download", "permissions"].includes(command.type))
        throw new Error(
          "This is a UI fixture. Recording, downloads, and permissions require the desktop runtime.",
        );
      for (const listener of listeners) listener(state);
      return state;
    },
  };
}

function PreviewContent({ page }: { page: string }) {
  const { state, bridge, execute, updatePreferences, error } = useDictation();
  const [wizardOpen, setWizardOpen] = useState(true);
  if (!state || !bridge || !execute || !updatePreferences) return null;
  const props = { state, execute, updatePreferences };
  if (page.startsWith("setup-"))
    return (
      <>
        <Button onClick={() => setWizardOpen(true)}>Open setup wizard</Button>
        {wizardOpen && (
          <DictationSetupDialog
            {...props}
            error={error}
            initialStep={
              page === "setup-access" ? "access" : page === "setup-models" ? "models" : "test"
            }
            onClose={() => setWizardOpen(false)}
          />
        )}
      </>
    );
  return (
    <>
      {error && <Notice error>{error}</Notice>}
      {page === "setup" ? (
        <DictationSetup {...props} />
      ) : page === "models" ? (
        <DictationModels {...props} />
      ) : page === "history" ? (
        <DictationHistory {...props} bridge={bridge} />
      ) : page === "dictionary" ? (
        <DictationDictionary
          {...props}
          saveDictionary={async (lists) => {
            await execute({ type: "dictionary", lists, connected: true });
          }}
        />
      ) : (
        <DictationSettings {...props} />
      )}
    </>
  );
}

export function DictationPreview() {
  const [configuration, setConfiguration] = useState<DictationFixtureName>("ready");
  const [page, setPage] = useState("models");
  const state = useMemo(() => makeDictationFixture(configuration), [configuration]);
  const bridge = useMemo(() => fixtureBridge(state), [state]);
  const [overlayHtml, setOverlayHtml] = useState("");
  const [overlayError, setOverlayError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!import.meta.env.DEV || page !== "overlay") return;
    setOverlayError(null);
    void (async () => {
      const { createDictationWidgetHtml }: { createDictationWidgetHtml: () => string } =
        await import(/* @vite-ignore */ widgetModuleUrl);
      const bootstrap = `window.dictationOverlay = {getState:async()=>(${JSON.stringify(state)}), execute:async()=>(${JSON.stringify(state)}), listHistory:async()=>(${JSON.stringify(dictationHistoryFixtures)}), onState:()=>()=>{}, resize:()=>{}, hide:()=>{document.getElementById("widget").style.visibility="hidden"}};`;
      if (active)
        setOverlayHtml(createDictationWidgetHtml().replace("<script>", `<script>${bootstrap}`));
    })().catch((cause: unknown) => {
      if (active)
        setOverlayError(
          cause instanceof Error ? cause.message : "The overlay fixture could not load.",
        );
    });
    return () => {
      active = false;
    };
  }, [state, page]);
  if (!import.meta.env.DEV) return null;
  return (
    <SettingsPageContainer className="max-w-3xl gap-8">
      <Notice>
        Fixture preview only. These screens use isolated sample data and do not prove microphone
        capture, native inference, permissions, downloads, or text insertion.
      </Notice>
      <div className="flex flex-wrap gap-3">
        <Choice
          label="Fixture configuration"
          value={configuration}
          options={dictationFixtureNames.map((value) => ({ value, label: value }))}
          onChange={setConfiguration}
        />
        <Choice
          label="Preview page"
          value={page}
          options={[
            "setup",
            "setup-access",
            "setup-models",
            "setup-test",
            "models",
            "history",
            "dictionary",
            "settings",
            "overlay",
          ].map((value) => ({ value, label: value }))}
          onChange={setPage}
        />
      </div>
      <header className="px-4">
        <p className="text-xs text-muted-foreground">Dictation · Fixture preview</p>
        <h1 className="mt-2 text-2xl font-semibold capitalize">{page}</h1>
      </header>
      {overlayError && page === "overlay" && <Notice error>{overlayError}</Notice>}
      {page === "overlay" ? (
        <div className="rounded-2xl border border-border bg-muted/25">
          <iframe
            title="Dictation overlay fixture"
            sandbox="allow-scripts"
            srcDoc={overlayHtml}
            className="h-[620px] w-full"
          />
        </div>
      ) : (
        <DictationBridgeContext value={bridge}>
          <PreviewContent key={`${configuration}:${page}`} page={page} />
        </DictationBridgeContext>
      )}
    </SettingsPageContainer>
  );
}
