import {
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@spiritdevs/contracts";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import type { EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { ComposerAttachment, DraftSessionState } from "../composerDraftStore";

export interface PlacementBinding {
  readonly companyId: CompanyId;
  readonly binding: EnvironmentBindingEntity;
}

/** Retain the selected checkout; an ambiguous remote binding needs a manual choice. */
export function selectPlacementProjects<
  T extends Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">,
>(
  source: T,
  projects: ReadonlyArray<T>,
  bindings: ReadonlyArray<PlacementBinding>,
): ReadonlyArray<T> {
  if (source.workspaceRoot === null) return [];
  const sourceBindings = bindings.filter(
    ({ binding }) =>
      binding.status === "active" &&
      binding.environmentId === source.environmentId &&
      binding.localProjectId === source.id,
  );
  const remoteProjectIds = new Map<EnvironmentId, Set<string>>();
  for (const { companyId, binding } of bindings) {
    if (
      binding.status !== "active" ||
      binding.environmentId === source.environmentId ||
      !sourceBindings.some(
        (entry) =>
          entry.companyId === companyId && entry.binding.cloudProjectId === binding.cloudProjectId,
      )
    )
      continue;
    const ids = remoteProjectIds.get(binding.environmentId) ?? new Set<string>();
    ids.add(binding.localProjectId);
    remoteProjectIds.set(binding.environmentId, ids);
  }
  const destinations: T[] = [source];
  for (const [environmentId, ids] of remoteProjectIds) {
    if (ids.size !== 1) continue;
    const target = projects.find(
      (project) =>
        project.environmentId === environmentId &&
        ids.has(project.id) &&
        project.workspaceRoot !== null,
    );
    if (target) destinations.push(target);
  }
  return destinations;
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

/** Once sending starts, retries must keep the same destination. */
export function draftPlacementIsLocked(draft: DraftSessionState): boolean {
  return Boolean(draft.pendingSend || draft.promotedTo || draft.placement?.dispatched);
}

/** Restored uploads without local bytes can only be used on their upload environment. */
export function draftAttachmentsAllowEnvironment(
  attachments: ReadonlyArray<ComposerAttachment> | undefined,
  environmentId: EnvironmentId,
): boolean {
  return (attachments ?? []).every(
    (attachment) =>
      attachment.type !== "file" ||
      attachment.file !== null ||
      attachment.uploadedAttachmentId === undefined ||
      attachment.uploadEnvironmentId === environmentId,
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
