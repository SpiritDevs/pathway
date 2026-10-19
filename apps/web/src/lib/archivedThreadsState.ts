import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@spiritdevs/client-runtime/state/threads";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { activeCompanyIdAtom, scopedCompanyRegistryReplicasAtom } from "../cloud/activeCompany";
import { companyScopedEnvironmentSnapshot } from "../cloud/agentThreadReadModel";
import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const companyScopedArchivedSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const companyId = get(activeCompanyIdAtom);
    const replicas = get(scopedCompanyRegistryReplicasAtom);
    return AsyncResult.map(get(archivedSnapshotAtom(environmentId)), (snapshot) =>
      companyScopedEnvironmentSnapshot(snapshot, companyId, replicas, environmentId),
    );
  }).pipe(Atom.withLabel(`web:company-scoped-archived-shell:${environmentId}`)),
);

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: companyScopedArchivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}
