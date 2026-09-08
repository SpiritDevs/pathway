import type { EnvironmentId, ModelSelection, ServerProvider } from "@spiritdevs/contracts";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import type { EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { DraftSessionState, ComposerThreadDraftState } from "../composerDraftStore";

export interface PlacementBinding {
  readonly companyId: CompanyId;
  readonly binding: EnvironmentBindingEntity;
}

/** Automatic placement needs explicit company project bindings, never sidebar grouping. */
export function projectsSharePlacementBinding(
  source: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">,
  target: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">,
  bindings: ReadonlyArray<PlacementBinding>,
): boolean {
  if (source.workspaceRoot === null || target.workspaceRoot === null) return false;
  if (source.environmentId === target.environmentId && source.id === target.id) return true;
  const sourceBindings = bindings.filter(
    ({ binding }) =>
      binding.status === "active" &&
      binding.environmentId === source.environmentId &&
      binding.localProjectId === source.id,
  );
  return sourceBindings.some((sourceBinding) =>
    bindings.some(
      ({ companyId, binding }) =>
        companyId === sourceBinding.companyId &&
        binding.status === "active" &&
        binding.cloudProjectId === sourceBinding.binding.cloudProjectId &&
        binding.environmentId === target.environmentId &&
        binding.localProjectId === target.id,
    ),
  );
}

/** Instance IDs are local; require the same driver, model and supported option values. */
export function resolvePlacementModel(
  selection: ModelSelection,
  source: ServerProvider,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  for (const provider of providers) {
    if (
      provider.driver !== source.driver ||
      !provider.enabled ||
      !provider.installed ||
      provider.availability === "unavailable" ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.auth.status !== "authenticated"
    )
      continue;
    const model = provider.models.find((candidate) => candidate.slug === selection.model);
    if (!model) continue;
    if (
      !(selection.options ?? []).every(({ id, value }) => {
        const descriptor = model.capabilities?.optionDescriptors?.find(
          (option) => option.id === id,
        );
        return descriptor?.type === "boolean"
          ? typeof value === "boolean"
          : descriptor?.type === "select" &&
              descriptor.options.some((option) => option.id === value);
      })
    )
      continue;
    return { ...selection, instanceId: provider.instanceId };
  }
  return null;
}

export function draftPlacementIsPinned(
  draft: DraftSessionState,
  composer: ComposerThreadDraftState | null | undefined,
): boolean {
  return (
    Boolean(draft.placement?.providerPinned) || draftPlacementHasMachineBinding(draft, composer)
  );
}

/** Machine-owned context prevents even an explicit move until its binding is removed. */
export function draftPlacementHasMachineBinding(
  draft: DraftSessionState,
  composer: ComposerThreadDraftState | null | undefined,
): boolean {
  return Boolean(
    draft.pendingSend ||
    draft.promotedTo ||
    draft.branch ||
    draft.envMode === "worktree" ||
    draft.worktreePath ||
    draft.placement?.dispatched ||
    composer?.images.length ||
    composer?.persistedAttachments.length ||
    composer?.terminalContexts.length ||
    composer?.elementContexts.length ||
    composer?.previewAnnotations.length ||
    composer?.reviewComments.length,
  );
}

export function placementSelectionKey(
  environmentId: EnvironmentId,
  projectId: string,
  selection: ModelSelection,
): string {
  return JSON.stringify([
    environmentId,
    projectId,
    selection.instanceId,
    selection.model,
    [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  ]);
}
