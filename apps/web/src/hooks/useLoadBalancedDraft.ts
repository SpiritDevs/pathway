import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { chooseLoadBalancedEnvironment } from "@spiritdevs/client-runtime/load-balancing";
import { scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { AuthOrchestrationOperateScope, type ModelSelection } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useMemo } from "react";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import type { Project } from "../types";
import type { EnvironmentPresentation } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { environmentSession } from "../state/session";
import {
  draftPlacementIsPinned,
  draftPlacementHasMachineBinding,
  placementSelectionKey,
  selectPlacementProjects,
  draftPlacementPinsProvider,
  resolvePlacementModel,
} from "../lib/draftPlacement";

const isBinding = Schema.is(EnvironmentBindingEntity);

/** Every new-thread entry point reaches this draft boundary before its first send. */
export function useLoadBalancedDraft(input: {
  draftId: DraftId | null;
  enabled: boolean;
  weights: Readonly<Record<string, number>>;
  project: Project | null;
  projects: ReadonlyArray<Project>;
  environments: ReadonlyArray<EnvironmentPresentation>;
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>;
  selection: ModelSelection | null;
}) {
  const { draftId, enabled, weights, project, projects, environments, replicas, selection } = input;
  const registry = useContext(RegistryContext);
  const draft = useComposerDraftStore((store) => (draftId ? store.getDraftSession(draftId) : null));
  const sourceProviders =
    environments.find((environment) => environment.environmentId === draft?.environmentId)
      ?.serverConfig?.providers ?? [];
  const inheritedProviderPinned =
    draft !== null && draftPlacementPinsProvider(draft, selection, sourceProviders);
  const contextPinned = useComposerDraftStore((store) => {
    const session = draftId ? store.getDraftSession(draftId) : null;
    return session && draftId
      ? draftPlacementIsPinned(session, store.getComposerDraft(draftId))
      : true;
  });
  const pinned = contextPinned || inheritedProviderPinned;
  const machinePinned = useComposerDraftStore((store) => {
    const session = draftId ? store.getDraftSession(draftId) : null;
    return session && draftId
      ? draftPlacementHasMachineBinding(session, store.getComposerDraft(draftId))
      : true;
  });
  const key =
    draft && selection
      ? placementSelectionKey(draft.environmentId, draft.projectId, selection)
      : null;
  const automatic =
    enabled &&
    project?.workspaceRoot != null &&
    draft !== null &&
    draft.placement?.mode !== "manual" &&
    !pinned;
  const resolved = automatic && key !== null && draft?.placement?.resolvedKey === key;
  const bindings = useMemo(
    () =>
      automatic
        ? [...replicas].flatMap(([companyId, replica]) =>
            [...replica.view.values()].flatMap((value) =>
              isBinding(value) ? [{ companyId, binding: value }] : [],
            ),
          )
        : [],
    [automatic, replicas],
  );
  const placementProjects = useMemo(
    () => (automatic && project ? selectPlacementProjects(project, projects, bindings) : []),
    [automatic, project, projects, bindings],
  );
  const placementEnvironments = useMemo(
    () =>
      automatic && project
        ? environments.filter(
            (environment) =>
              environment.connection.phase === "connected" &&
              (weights[environment.environmentId] ?? 50) > 0 &&
              placementProjects.some(
                (target) => target.environmentId === environment.environmentId,
              ),
          )
        : [],
    [automatic, project, environments, weights, placementProjects],
  );
  const accessAtom = useMemo(
    () =>
      Atom.make((get) =>
        automatic
          ? placementEnvironments.map((environment) => ({
              environmentId: environment.environmentId,
              session: get(environmentSession.sessionStateAtom(environment.environmentId)),
            }))
          : [],
      ),
    [automatic, placementEnvironments],
  );
  const sessions = useAtomValue(accessAtom);
  const candidates = useMemo(() => {
    if (!automatic || !project || !selection) return [];
    const source = environments
      .find((environment) => environment.environmentId === project.environmentId)
      ?.serverConfig?.providers.find((provider) => provider.instanceId === selection.instanceId);
    if (!source) return [];
    return placementProjects.flatMap((target) => {
      const session = sessions.find(
        (entry) => entry.environmentId === target.environmentId,
      )?.session;
      if (
        session?._tag !== "Success" ||
        !session.value.authenticated ||
        !session.value.scopes?.includes(AuthOrchestrationOperateScope)
      )
        return [];
      const environment = environments.find(
        (candidate) => candidate.environmentId === target.environmentId,
      );
      if (
        environment?.connection.phase !== "connected" ||
        !environment.serverConfig ||
        (weights[target.environmentId] ?? 50) <= 0
      )
        return [];
      const providers = (
        target.environmentId === project.environmentId
          ? [source]
          : [...environment.serverConfig.providers]
      ).sort(
        (a, b) =>
          Number(b.instanceId === selection.instanceId) -
          Number(a.instanceId === selection.instanceId),
      );
      const modelSelection = resolvePlacementModel(selection, source, providers);
      if (!modelSelection) return [];
      return [
        {
          environmentId: target.environmentId,
          projectId: target.id,
          modelSelection,
          weight: weights[target.environmentId] ?? 50,
        },
      ];
    });
  }, [automatic, project, selection, environments, placementProjects, weights, sessions]);
  const measurementsAtom = useMemo(
    () =>
      Atom.make((get) =>
        automatic && !resolved
          ? candidates.map((candidate) => ({
              ...candidate,
              result: get(
                serverEnvironment.hostResources({
                  environmentId: candidate.environmentId,
                  input: {},
                }),
              ),
            }))
          : [],
      ),
    [automatic, resolved, candidates],
  );
  const measurements = useAtomValue(measurementsAtom);
  const pending =
    automatic &&
    !resolved &&
    (sessions.some(
      ({ session }) =>
        session._tag === "Initial" || (session.waiting && session._tag !== "Success"),
    ) ||
      measurements.length !== candidates.length ||
      measurements.some(({ result }) => result.waiting || result._tag === "Initial"));

  useEffect(() => {
    if (!draftId || !automatic || resolved || pending || !key) return;
    const environmentId = chooseLoadBalancedEnvironment(
      measurements.map(({ result, ...candidate }) => ({
        ...candidate,
        resources: result._tag === "Success" ? result.value : null,
        receivedAt: result._tag === "Success" ? result.timestamp : 0,
      })),
      Date.now(),
      draftId,
    );
    const destination = candidates.find((candidate) => candidate.environmentId === environmentId);
    if (!destination) return;
    const store = useComposerDraftStore.getState();
    const current = store.getDraftSession(draftId);
    // Uploads or manual choices may have arrived while measurements were in flight.
    if (
      !current ||
      current.placement?.mode === "manual" ||
      draftPlacementIsPinned(current, store.getComposerDraft(draftId))
    )
      return;
    if (
      current.environmentId !== draft?.environmentId ||
      current.projectId !== draft.projectId ||
      current.placement?.resolvedKey !== draft.placement?.resolvedKey
    )
      return;
    const currentComposer = store.getComposerDraft(draftId);
    const currentSelection = currentComposer?.activeProvider
      ? currentComposer.modelSelectionByProvider[currentComposer.activeProvider]
      : null;
    if (
      currentSelection &&
      placementSelectionKey(current.environmentId, current.projectId, currentSelection) !== key
    )
      return;
    store.setModelSelection(draftId, destination.modelSelection, { replaceOptions: true });
    store.setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(destination.environmentId, destination.projectId),
      placement: {
        mode: "auto",
        providerPinned: false,
        automaticProviderInstanceId: destination.modelSelection.instanceId,
        resolvedKey: placementSelectionKey(
          destination.environmentId,
          destination.projectId,
          destination.modelSelection,
        ),
      },
    });
  }, [draftId, draft, selection, automatic, resolved, pending, key, measurements, candidates]);

  const recheck = useCallback(() => {
    if (!draftId) return;
    const store = useComposerDraftStore.getState();
    const current = store.getDraftSession(draftId);
    const composer = store.getComposerDraft(draftId);
    const currentSelection = composer?.activeProvider
      ? composer.modelSelectionByProvider[composer.activeProvider]
      : selection;
    const currentProviders =
      environments.find((environment) => environment.environmentId === current?.environmentId)
        ?.serverConfig?.providers ?? [];
    if (
      !current ||
      draftPlacementIsPinned(current, composer) ||
      draftPlacementPinsProvider(current, currentSelection, currentProviders)
    )
      return;
    for (const candidate of candidates)
      registry.refresh(
        serverEnvironment.hostResources({ environmentId: candidate.environmentId, input: {} }),
      );
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      placement: { ...current.placement, mode: "auto", providerPinned: false, resolvedKey: null },
    });
  }, [draftId, selection, environments, registry, candidates]);
  const useManual = useCallback(() => {
    if (!draftId) return;
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      placement: {
        mode: "manual",
        providerPinned: draft?.placement?.providerPinned ?? false,
        resolvedKey: null,
      },
    });
  }, [draftId, draft?.placement?.providerPinned]);
  const eligible =
    resolved &&
    candidates.some(
      (candidate) =>
        candidate.environmentId === draft?.environmentId &&
        candidate.projectId === draft.projectId &&
        placementSelectionKey(
          candidate.environmentId,
          candidate.projectId,
          candidate.modelSelection,
        ) === key,
    );
  return {
    visible: enabled && draft !== null && project?.workspaceRoot != null,
    automatic,
    pinned,
    machinePinned,
    pending,
    blocked: automatic && (!resolved || !eligible),
    label: automatic
      ? pending
        ? "Auto · checking machines"
        : eligible
          ? `Auto · ${environments.find((environment) => environment.environmentId === draft?.environmentId)?.label ?? "Selected machine"}`
          : "Auto · choose a machine or recheck"
      : "Manual placement",
    detail: pinned
      ? "This draft is pinned by its account, workspace, attachments, or launch."
      : candidates.length < 2
        ? "Balancing needs another connected binding with a matching authenticated provider and model."
        : "Uses matching providers on your project’s connected machines.",
    recheck,
    useManual,
    validate: (sendSelection: ModelSelection) =>
      !automatic ||
      Boolean(
        eligible &&
        draft &&
        placementSelectionKey(draft.environmentId, draft.projectId, sendSelection) === key,
      ),
  };
}
