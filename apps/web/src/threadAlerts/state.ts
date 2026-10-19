import { Atom } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { ConvexClient } from "convex/browser";
import type { FocusNotification } from "@spiritdevs/contracts/focus";
import { makeFunctionReference } from "convex/server";
import {
  AlertPolicyRow,
  alertProjectScopeKey,
  alertThreadScopeKey,
  type AlertPolicyOverride,
  type AlertPolicyScopeKind,
} from "@spiritdevs/contracts/threadAlerts";
import { environmentProjects } from "../state/projects";
import { environmentThreadShells } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { createOptimisticAlertPolicies } from "./optimisticPolicy";

export interface ThreadAlertMutations {
  upsert: (input: {
    scopeKind: AlertPolicyScopeKind;
    scopeKey: string;
    choices: AlertPolicyOverride;
  }) => Promise<null>;
  reset: (input: { scopeKind: AlertPolicyScopeKind; scopeKey: string }) => Promise<null>;
}
export const threadAlertPoliciesAtom = Atom.make<ReadonlyArray<AlertPolicyRow> | null>(null).pipe(
  Atom.keepAlive,
);
export const threadAlertMutationsAtom = Atom.make<ThreadAlertMutations | null>(null).pipe(
  Atom.keepAlive,
);
export const threadAlertConnectedAtom = Atom.make(false).pipe(Atom.keepAlive);
export const threadAlertAccountAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);
export const threadAlertNotificationsReadyAtom = Atom.make(false).pipe(Atom.keepAlive);
export const threadAlertPoliciesReadyAtom = Atom.make(false).pipe(Atom.keepAlive);
export const threadAlertPoliciesErrorAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);
export const threadAlertPolicyScopesAtom = Atom.make<{
  readonly projectKeys: readonly string[];
  readonly threadKeys: readonly string[];
} | null>(null).pipe(Atom.keepAlive);

const scopesAtom = Atom.make((get) =>
  JSON.stringify({
    projectKeys: [
      ...new Set(
        get(environmentProjects.projectsAtom).map((project) =>
          alertProjectScopeKey(
            project.environmentId,
            project.id,
            project.repositoryIdentity?.canonicalKey,
          ),
        ),
      ),
    ].sort(),
    threadKeys: get(environmentThreadShells.threadRefsAtom)
      .map((thread) => alertThreadScopeKey(thread.environmentId, thread.threadId))
      .sort(),
  }),
);
const listReference = makeFunctionReference<
  "query",
  { projectKeys: string[]; threadKeys: string[] },
  ReadonlyArray<AlertPolicyRow>
>("threadAlertPolicies:list");
const upsertReference = makeFunctionReference<
  "mutation",
  Parameters<ThreadAlertMutations["upsert"]>[0],
  null
>("threadAlertPolicies:upsert");
const resetReference = makeFunctionReference<
  "mutation",
  Parameters<ThreadAlertMutations["reset"]>[0],
  null
>("threadAlertPolicies:reset");
const decodePolicies = Schema.decodeUnknownOption(Schema.Array(AlertPolicyRow));

/** Reuses the Focus client and replaces its policy query only when shell scope keys change. */
export function subscribeThreadAlertPolicies(
  client: ConvexClient,
  accountScope: string,
  notificationsAtom: Atom.Atom<readonly FocusNotification[]>,
): () => void {
  appAtomRegistry.set(threadAlertAccountAtom, accountScope);
  let active = true;
  let generation = 0;
  appAtomRegistry.set(threadAlertPoliciesReadyAtom, false);
  appAtomRegistry.set(threadAlertPoliciesErrorAtom, null);
  appAtomRegistry.set(threadAlertPolicyScopesAtom, null);
  appAtomRegistry.set(threadAlertPoliciesAtom, null);
  const isActive = () => active && appAtomRegistry.get(threadAlertAccountAtom) === accountScope;
  const optimistic = createOptimisticAlertPolicies((rows) => {
    if (isActive()) appAtomRegistry.set(threadAlertPoliciesAtom, rows);
  });
  appAtomRegistry.set(threadAlertMutationsAtom, {
    upsert: (input) => optimistic.write(input, () => client.mutation(upsertReference, input)),
    reset: (input) =>
      optimistic.write({ ...input, choices: {} }, () => client.mutation(resetReference, input)),
  });
  let unsubscribeQuery = () => {};
  const requestedScopes = Atom.make((get) => {
    const scopes: { projectKeys: string[]; threadKeys: string[] } = JSON.parse(get(scopesAtom));
    const notifications = get(notificationsAtom);
    return JSON.stringify({
      projectKeys: [
        ...new Set([
          ...scopes.projectKeys,
          ...notifications.flatMap((row) => (row.alertProjectKey ? [row.alertProjectKey] : [])),
        ]),
      ].sort(),
      threadKeys: [
        ...new Set([
          ...scopes.threadKeys,
          ...notifications.map((row) => alertThreadScopeKey(row.environmentId, row.threadId)),
        ]),
      ].sort(),
    });
  });
  const unsubscribeScopes = appAtomRegistry.subscribe(
    requestedScopes,
    (serialized) => {
      if (!isActive()) return;
      const queryGeneration = ++generation;
      unsubscribeQuery();
      appAtomRegistry.set(threadAlertPoliciesReadyAtom, false);
      appAtomRegistry.set(threadAlertPoliciesErrorAtom, null);
      const scopes: { projectKeys: string[]; threadKeys: string[] } = JSON.parse(serialized);
      unsubscribeQuery = client.onUpdate(
        listReference,
        scopes,
        (value) => {
          if (!isActive() || queryGeneration !== generation) return;
          const decoded = decodePolicies(value);
          if (Option.isSome(decoded)) {
            appAtomRegistry.set(threadAlertPoliciesErrorAtom, null);
            appAtomRegistry.set(threadAlertPolicyScopesAtom, scopes);
            optimistic.receive(decoded.value);
            appAtomRegistry.set(threadAlertPoliciesReadyAtom, true);
          } else {
            appAtomRegistry.set(threadAlertPoliciesReadyAtom, false);
            appAtomRegistry.set(
              threadAlertPoliciesErrorAtom,
              "Could not load thread alert settings from Pathway Cloud. Reload Pathway to try again.",
            );
          }
        },
        (error) => {
          if (!isActive() || queryGeneration !== generation) return;
          appAtomRegistry.set(threadAlertPoliciesReadyAtom, false);
          appAtomRegistry.set(
            threadAlertPoliciesErrorAtom,
            "Could not load thread alert settings from Pathway Cloud. Reload Pathway to try again.",
          );
          console.warn("Could not load thread alert policy.", error);
        },
      );
    },
    { immediate: true },
  );
  const updateConnection = () => {
    if (isActive())
      appAtomRegistry.set(threadAlertConnectedAtom, client.connectionState().isWebSocketConnected);
  };
  updateConnection();
  const unsubscribeConnection = client.subscribeToConnectionState(updateConnection);
  return () => {
    active = false;
    unsubscribeScopes();
    unsubscribeQuery();
    unsubscribeConnection();
    if (appAtomRegistry.get(threadAlertAccountAtom) !== accountScope) return;
    appAtomRegistry.set(threadAlertPolicyScopesAtom, null);
    appAtomRegistry.set(threadAlertPoliciesAtom, null);
    appAtomRegistry.set(threadAlertMutationsAtom, null);
    appAtomRegistry.set(threadAlertAccountAtom, null);
    appAtomRegistry.set(threadAlertConnectedAtom, false);
    appAtomRegistry.set(threadAlertNotificationsReadyAtom, false);
    appAtomRegistry.set(threadAlertPoliciesReadyAtom, false);
    appAtomRegistry.set(threadAlertPoliciesErrorAtom, null);
  };
}
