import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@spiritdevs/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { activeCompanyIdAtom, scopedCompanyRegistryReplicasAtom } from "../cloud/activeCompany";
import {
  cloudEnvironmentThreadsAtom,
  companyScopedEnvironmentThreads,
} from "../cloud/agentThreadReadModel";
import { personalConversationsAtom } from "../cloud/conversationSharing";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

const personalConversationEnvironmentIdsAtom = Atom.make((get) => [
  ...new Set(get(personalConversationsAtom).map((conversation) => conversation.environmentId)),
]);

const personalEnvironmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<OrchestrationV2ThreadShell> =>
      get(personalConversationsAtom)
        .filter(
          (conversation) =>
            conversation.environmentId === environmentId &&
            conversation.shell.archivedAt === null &&
            conversation.shell.deletedAt === null,
        )
        .map(({ shell }) => ({
          ...shell,
          latestVisibleMessage:
            shell.latestVisibleMessage === null
              ? null
              : { ...shell.latestVisibleMessage, text: "" },
        })),
  ),
);

const discoveredEnvironmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => [
    ...get(cloudEnvironmentThreadsAtom(environmentId)),
    ...get(personalEnvironmentThreadsAtom(environmentId)),
  ]),
);

const companyScopedThreadSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const snapshot = get(environmentSnapshotAtom(environmentId));
    if (snapshot === null) return null;
    const threads = companyScopedEnvironmentThreads(
      snapshot.threads,
      get(activeCompanyIdAtom),
      get(scopedCompanyRegistryReplicasAtom),
      environmentId,
    );
    return threads === snapshot.threads ? snapshot : { ...snapshot, threads };
  }).pipe(Atom.withLabel(`company-scoped-thread-snapshot:${environmentId}`)),
);

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: companyScopedThreadSnapshotAtom,
  fallbackThreadsAtom: discoveredEnvironmentThreadsAtom,
  discoveryEnvironmentIdsAtom: personalConversationEnvironmentIdsAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}
