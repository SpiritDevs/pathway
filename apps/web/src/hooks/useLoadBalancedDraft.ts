import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { chooseLoadBalancedEnvironment } from "@spiritdevs/client-runtime/load-balancing";
import { scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ScopedProjectRef,
} from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import type { Project } from "../types";
import type { EnvironmentPresentation } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { environmentSession } from "../state/session";
import {
  draftAttachmentsAllowEnvironment,
  draftPlacementIsLocked,
  placementSelectionKey,
  selectPlacementProjects,
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
  const attachments = useComposerDraftStore((store) =>
    draftId ? store.getComposerDraft(draftId)?.images : undefined,
  );
  const locked = draft === null || draftPlacementIsLocked(draft);
  const visible = enabled && draft !== null && project?.workspaceRoot != null;
  const canBalance = visible && !locked;
  const automatic = visible && draft?.placement?.mode !== "manual";
  const key =
    draft?.projectId != null && selection
      ? placementSelectionKey(draft.environmentId, draft.projectId, selection)
      : null;
  // Keep the recommendation while the user chooses a manual override. Resource
  // changes alone must not move a draft or change the machine advertised by Auto.
  const [recommendation, setRecommendation] = useState<{
    draftId: DraftId;
    key: string;
    environmentId: EnvironmentId;
  } | null>(null);
  const storedResolution =
    key !== null &&
    draft?.placement?.resolvedKey === key &&
    draftAttachmentsAllowEnvironment(attachments, draft.environmentId);
  const hasRecommendation =
    recommendation?.draftId === draftId &&
    recommendation?.key === key &&
    draftAttachmentsAllowEnvironment(attachments, recommendation.environmentId);
  const resolved = storedResolution || hasRecommendation;
  const recommendedEnvironmentId = storedResolution
    ? draft?.environmentId
    : hasRecommendation
      ? recommendation.environmentId
      : null;
  const bindings = useMemo(
    () =>
      canBalance
        ? [...replicas].flatMap(([companyId, replica]) =>
            [...replica.view.values()].flatMap((value) =>
              isBinding(value) ? [{ companyId, binding: value }] : [],
            ),
          )
        : [],
    [canBalance, replicas],
  );
  const placementProjects = useMemo(
    () =>
      canBalance && project
        ? selectPlacementProjects(project, projects, bindings).filter((target) =>
            draftAttachmentsAllowEnvironment(attachments, target.environmentId),
          )
        : [],
    [canBalance, project, projects, bindings, attachments],
  );
  const placementEnvironments = useMemo(
    () =>
      canBalance && project
        ? environments.filter(
            (environment) =>
              environment.connection.phase === "connected" &&
              (weights[environment.environmentId] ?? 50) > 0 &&
              placementProjects.some(
                (target) => target.environmentId === environment.environmentId,
              ),
          )
        : [],
    [canBalance, project, environments, weights, placementProjects],
  );
  const accessAtom = useMemo(
    () =>
      Atom.make((get) =>
        canBalance
          ? placementEnvironments.map((environment) => ({
              environmentId: environment.environmentId,
              session: get(environmentSession.sessionStateAtom(environment.environmentId)),
            }))
          : [],
      ),
    [canBalance, placementEnvironments],
  );
  const sessions = useAtomValue(accessAtom);
  const candidates = useMemo(() => {
    if (!canBalance || !project || !selection) return [];
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
  }, [canBalance, project, selection, environments, placementProjects, weights, sessions]);
  const measurementsAtom = useMemo(
    () =>
      Atom.make((get) =>
        canBalance && !resolved
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
    [canBalance, resolved, candidates],
  );
  const measurements = useAtomValue(measurementsAtom);
  const pending =
    canBalance &&
    !resolved &&
    (sessions.some(
      ({ session }) =>
        session._tag === "Initial" || (session.waiting && session._tag !== "Success"),
    ) ||
      measurements.length !== candidates.length ||
      measurements.some(({ result }) => result.waiting || result._tag === "Initial"));

  const measuredEnvironmentId =
    !resolved && !pending && draftId
      ? chooseLoadBalancedEnvironment(
          measurements.map(({ result, ...candidate }) => ({
            ...candidate,
            resources: result._tag === "Success" ? result.value : null,
            receivedAt: result._tag === "Success" ? result.timestamp : 0,
          })),
          Date.now(),
          draftId,
        )
      : null;
  const recommended = candidates.find(
    (candidate) =>
      candidate.environmentId === (resolved ? recommendedEnvironmentId : measuredEnvironmentId),
  );

  useEffect(() => {
    if (!draftId || !canBalance || pending || !key || !recommended) return;
    const store = useComposerDraftStore.getState();
    const current = store.getDraftSession(draftId);
    if (!current || current.projectId === null || draftPlacementIsLocked(current)) return;
    if (
      current.environmentId !== draft?.environmentId ||
      current.projectId !== draft.projectId ||
      current.placement?.mode !== draft.placement?.mode ||
      current.placement?.resolvedKey !== draft.placement?.resolvedKey
    )
      return;
    const composer = store.getComposerDraft(draftId);
    if (!draftAttachmentsAllowEnvironment(composer?.images, recommended.environmentId)) return;
    const currentSelection = composer?.activeProvider
      ? composer.modelSelectionByProvider[composer.activeProvider]
      : null;
    if (
      currentSelection &&
      placementSelectionKey(current.environmentId, current.projectId, currentSelection) !== key
    )
      return;
    if (!resolved) setRecommendation({ draftId, key, environmentId: recommended.environmentId });
    const destination = recommended;
    if (!automatic || storedResolution) return;
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
  }, [
    draftId,
    draft,
    canBalance,
    automatic,
    resolved,
    storedResolution,
    recommended,
    pending,
    key,
  ]);

  const selectAuto = useCallback(() => {
    if (!draftId) return;
    const store = useComposerDraftStore.getState();
    const current = store.getDraftSession(draftId);
    if (!current || current.projectId === null || draftPlacementIsLocked(current)) return;
    // A manual choice is reversible even when the draft has a branch, a custom
    // account, or attachments. Selecting Auto explicitly opts into its destination.
    const composer = store.getComposerDraft(draftId);
    const currentSelection = composer?.activeProvider
      ? composer.modelSelectionByProvider[composer.activeProvider]
      : null;
    const canUseRecommendation =
      currentSelection &&
      placementSelectionKey(current.environmentId, current.projectId, currentSelection) === key &&
      recommended !== undefined;
    if (!canUseRecommendation) {
      setRecommendation(null);
      for (const candidate of candidates)
        registry.refresh(
          serverEnvironment.hostResources({ environmentId: candidate.environmentId, input: {} }),
        );
    }
    store.setDraftThreadContext(draftId, {
      placement: {
        mode: "auto",
        providerPinned: false,
        resolvedKey: canUseRecommendation && storedResolution ? key : null,
      },
    });
  }, [draftId, registry, candidates, key, recommended, storedResolution]);
  const selectEnvironment = useCallback(
    (target: ScopedProjectRef) => {
      if (!draftId) return;
      const store = useComposerDraftStore.getState();
      const current = store.getDraftSession(draftId);
      if (!current || draftPlacementIsLocked(current)) return;
      const source = environments
        .find((environment) => environment.environmentId === current.environmentId)
        ?.serverConfig?.providers.find((provider) => provider.instanceId === selection?.instanceId);
      const providers =
        environments.find((environment) => environment.environmentId === target.environmentId)
          ?.serverConfig?.providers ?? [];
      const nextSelection =
        source && selection
          ? resolvePlacementModel(
              selection,
              source,
              [...providers].sort(
                (a, b) =>
                  Number(b.instanceId === selection.instanceId) -
                  Number(a.instanceId === selection.instanceId),
              ),
            )
          : null;
      if (nextSelection) store.setModelSelection(draftId, nextSelection, { replaceOptions: true });
      store.setDraftThreadContext(draftId, {
        projectRef: target,
        placement: { mode: "manual", providerPinned: false, resolvedKey: null },
      });
    },
    [draftId, environments, selection],
  );

  const eligible =
    storedResolution &&
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
    visible,
    automatic,
    locked,
    pending,
    blocked: automatic && !locked && !eligible,
    label:
      pending || key === null
        ? "Auto: checking machines"
        : recommended
          ? `Auto: ${environments.find((environment) => environment.environmentId === recommended.environmentId)?.label ?? "Selected machine"}`
          : "Auto: no available machine",
    selectAuto,
    selectEnvironment,
    validate: (sendSelection: ModelSelection) =>
      !automatic ||
      locked ||
      Boolean(
        eligible &&
        draft &&
        draft.projectId !== null &&
        placementSelectionKey(draft.environmentId, draft.projectId, sendSelection) === key,
      ),
  };
}
