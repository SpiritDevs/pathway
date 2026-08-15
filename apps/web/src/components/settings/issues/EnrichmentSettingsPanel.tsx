/**
 * Settings → Issues → Enrichment.
 *
 * One setting, and a paragraph explaining what pressing Investigate actually does. The model
 * picker is the same pair the General page's text-generation row uses — `ProviderModelPicker` for
 * the instance and model, `TraitsPicker` for the options that instance exposes — because this is
 * the same kind of choice about the same set of providers, and the key it writes defaults to the
 * text-generation selection.
 *
 * @module components/settings/issues/EnrichmentSettingsPanel
 */
import { useAtomValue } from "@effect/atom-react";
import { ProviderDriverKind } from "@spiritdevs/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@spiritdevs/contracts/settings";
import { createModelSelection } from "@spiritdevs/shared/model";
import * as Equal from "effect/Equal";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { primaryServerProvidersAtom } from "../../../state/server";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { TraitsPicker } from "../../chat/TraitsPicker";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";

/** The same stand-in the General page uses when the selected instance is gone. */
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function EnrichmentSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);

  const selection = settings.issueEnrichmentModelSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const driverKind = instanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );
  const isDirty = !Equal.equals(selection, DEFAULT_UNIFIED_SETTINGS.issueEnrichmentModelSelection);

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("issue-enrichment")}>
        <SettingsRow
          title="What enrichment does"
          description="Investigate runs the model once over the issue's project directory and records the problem restated, likely files, related issues, labels, priority, and safe missing-field suggestions. It applies priority and an empty description automatically, and replaces a generic system title automatically. User-written title changes and labels still ask for confirmation."
        />

        <SettingsRow
          title="Runs are read-only"
          description="The investigation is started in the provider's read-only mode and cannot edit, stage, or commit anything. It never runs on import, and it is skipped for a project with no directory attached. One runs at a time; a second is queued behind it."
        />

        <SettingsRow
          {...searchableSetting("issue-enrichment-model")}
          description="The model an investigation runs. Defaults to the text generation model; changing it here does not change that one."
          resetAction={
            isDirty ? (
              <SettingResetButton
                label="investigation model"
                onClick={() =>
                  updateSettings({
                    issueEnrichmentModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.issueEnrichmentModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={selection.instanceId}
                instanceEntries={instanceEntries}
                lockedProvider={null}
                model={selection.model}
                modelOptionsByInstance={modelOptionsByInstance}
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    issueEnrichmentModelSelection: createModelSelection(instanceId, model),
                  });
                }}
                triggerAriaLabel="Investigation model"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                triggerVariant="outline"
              />
              <TraitsPicker
                allowPromptInjectedEffort={false}
                model={selection.model}
                modelOptions={selection.options}
                // The exact instance's models, not the first of its kind: a custom instance has
                // its own list, and the General page makes the same point.
                models={instanceEntry?.models ?? []}
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    issueEnrichmentModelSelection: createModelSelection(
                      selection.instanceId,
                      selection.model,
                      nextOptions,
                    ),
                  });
                }}
                onPromptChange={() => {}}
                prompt=""
                provider={driverKind}
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                triggerVariant="outline"
              />
            </div>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
