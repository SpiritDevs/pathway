import { useAtomValue } from "@effect/atom-react";
import { ProviderDriverKind } from "@spiritdevs/contracts";
import { createModelSelection } from "@spiritdevs/shared/model";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { primaryServerProvidersAtom } from "../../state/server";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function TimeTrackerSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const selection = resolveAppModelSelectionState(
    { ...settings, textGenerationModelSelection: settings.timeTrackerModelSelection },
    providers,
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings).filter(
      (entry) => ["codex", "claudeAgent", "opencode"].includes(entry.driverKind),
    ),
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Time Tracker">
        <SettingsRow
          title="Summary model"
          description="Writes a title and activity description after each agent tracking period ends. Uses the recorded work from that run and keeps a link to its thread."
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  selection.instanceId,
                  selection.model,
                )}
                triggerVariant="outline"
                onInstanceModelChange={(instanceId, model) =>
                  updateSettings({
                    timeTrackerModelSelection: createModelSelection(instanceId, model),
                  })
                }
              />
              <TraitsPicker
                allowPromptInjectedEffort={false}
                model={selection.model}
                modelOptions={selection.options}
                models={instanceEntry?.models ?? []}
                provider={instanceEntry?.driverKind ?? ProviderDriverKind.make("codex")}
                prompt=""
                onPromptChange={() => {}}
                onModelOptionsChange={(options) =>
                  updateSettings({
                    timeTrackerModelSelection: createModelSelection(
                      selection.instanceId,
                      selection.model,
                      options,
                    ),
                  })
                }
                triggerVariant="outline"
              />
            </div>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
