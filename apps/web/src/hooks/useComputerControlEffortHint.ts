import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ScopedThreadRef,
  ServerProviderModel,
} from "@spiritdevs/contracts";
import { resolveComputerInvocationMode } from "@spiritdevs/shared/computerInvocation";
import { getProviderOptionDescriptors } from "@spiritdevs/shared/model";
import { useCallback, useMemo } from "react";

import {
  buildComputerControlHintOptions,
  getComputerControlEffortHintTraits,
  shouldShowComputerControlEffortHint,
} from "../components/chat/composerComputerControlHint";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useCachedComputerStatus, useThreadComputerAvailability } from "../computerStateStore";
import { getProviderModelCapabilities } from "../providerModels";
import { useUpdateClientSettings } from "./useSettings";

/**
 * The composer's one-shot Medium effort tip for chats that drive the desktop.
 * Both actions retire the tip for good through `dismissedComputerControlEffortHint`.
 */
export function useComputerControlEffortHint(input: {
  readonly draftTarget: ScopedThreadRef | DraftId;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  /** `useComputerSupport(environmentId)`: this server could drive a desktop at all. */
  readonly computerSupported: boolean;
  readonly computerControlEnabled: boolean;
  readonly dismissed: boolean;
  readonly prompt: string;
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly focusComposer: () => void;
}) {
  const threadAvailability = useThreadComputerAvailability(input.threadRef);
  // A draft has no server thread state yet; the environment's last status stands in.
  const cachedStatus = useCachedComputerStatus(input.environmentId);
  const computerControlAvailable =
    input.computerSupported &&
    (threadAvailability ?? cachedStatus?.availability)?.kind === "available";
  const enableComputerControl =
    resolveComputerInvocationMode({
      messageText: input.prompt,
      enableComputerControl: input.computerControlEnabled,
    }) !== "off";
  const { models, model, provider, modelOptions, prompt } = input;
  const descriptors = useMemo(
    () =>
      getProviderOptionDescriptors({
        caps: getProviderModelCapabilities(models, model, provider),
        selections: modelOptions,
      }),
    [models, model, provider, modelOptions],
  );
  const traits = useMemo(
    () => getComputerControlEffortHintTraits({ descriptors, prompt }),
    [descriptors, prompt],
  );
  const show = shouldShowComputerControlEffortHint({
    enableComputerControl,
    computerControlAvailable,
    dismissed: input.dismissed,
    provider,
    traits,
  });

  const updateClientSettings = useUpdateClientSettings();
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const { draftTarget, instanceId, focusComposer } = input;
  const apply = useCallback(() => {
    setProviderModelOptions(draftTarget, provider, buildComputerControlHintOptions(descriptors), {
      instanceId,
      model,
      persistSticky: true,
    });
    void updateClientSettings({ dismissedComputerControlEffortHint: true });
    focusComposer();
  }, [
    descriptors,
    draftTarget,
    focusComposer,
    instanceId,
    model,
    provider,
    setProviderModelOptions,
    updateClientSettings,
  ]);
  const dismiss = useCallback(() => {
    void updateClientSettings({ dismissedComputerControlEffortHint: true });
    focusComposer();
  }, [focusComposer, updateClientSettings]);

  return { show, apply, dismiss };
}
