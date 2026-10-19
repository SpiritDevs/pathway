import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@spiritdevs/client-runtime/connection";
import { Discovery } from "@spiritdevs/client-runtime/relay";
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations, useEnvironmentPresentation } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
  readonly relayAccountManaged: boolean;
  readonly relayAccountLabel: string | null;
}

function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
  relayAccountLabel: string | null,
): EnvironmentPresentation {
  const descriptor =
    presentation.serverConfig?.environment ?? presentation.entry.descriptor ?? null;
  const configuredName = presentation.serverConfig?.settings.environmentName.trim();
  return {
    ...presentation,
    environmentId,
    label:
      relayAccountLabel || configuredName || descriptor?.label || presentation.entry.target.label,
    descriptor,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
    relayAccountManaged: relayAccountLabel !== null,
    relayAccountLabel,
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const relayDiscovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(
          environmentId,
          presentation,
          relayDiscovery.environments.get(environmentId)?.environment.label ?? null,
        ),
      ),
    [presentationById, relayDiscovery.environments],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const relayDiscovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(
            environmentId,
            presentation,
            relayDiscovery.environments.get(environmentId)?.environment.label ?? null,
          ),
    [environmentId, presentation, relayDiscovery.environments],
  );
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

export function useEnvironmentConnectionState(environmentId: EnvironmentId) {
  return useEnvironmentQuery(environmentCatalog.stateAtom(environmentId));
}
