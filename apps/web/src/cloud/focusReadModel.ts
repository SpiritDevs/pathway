import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import {
  ALL_FOCUS_ID,
  focusAssignmentsAtom,
  focusReadModelAtom,
  resolveActiveFocusId,
  scopedProjectKeysForFocus,
  type ActiveFocusId,
} from "@spiritdevs/client-runtime/state/focuses";
import {
  FOCUS_NOTIFICATION_MAX_PER_USER,
  FocusId,
  FocusNotification as FocusNotificationSchema,
  FocusProjectKey,
  FocusReadModel as FocusReadModelSchema,
  type Focus,
  type FocusNotification,
  type FocusReadModel,
} from "@spiritdevs/contracts/focus";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { scopedProjectKey, scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import type { ConvexAuthTokenFetcher } from "./syncTransport";

export {
  ALL_FOCUS_ID,
  focusAssignmentsAtom,
  focusListAtom,
} from "@spiritdevs/client-runtime/state/focuses";

type ConvexArgs = Record<string, unknown>;

const queryReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"query", Request, Response>(name);
const mutationReference = <Request extends ConvexArgs, Response>(name: string) =>
  makeFunctionReference<"mutation", Request, Response>(name);

export const FOCUS_FUNCTION_REFERENCES = {
  readModel: queryReference<{}, FocusReadModel>("focuses:list"),
  create: mutationReference<
    {
      readonly id: FocusId;
      readonly name: string;
      readonly iconName: string;
      readonly accentColor: string;
      readonly orderKey?: string;
    },
    Focus
  >("focuses:create"),
  update: mutationReference<
    {
      readonly focusId: FocusId;
      readonly name?: string;
      readonly iconName?: string;
      readonly accentColor?: string;
    },
    Focus
  >("focuses:update"),
  reorder: mutationReference<{ readonly focusId: FocusId; readonly orderKey: string }, null>(
    "focuses:reorder",
  ),
  remove: mutationReference<{ readonly focusId: FocusId }, null>("focuses:remove"),
  assignProject: mutationReference<
    { readonly focusId: FocusId; readonly projectKey: FocusProjectKey },
    null
  >("focuses:assignProject"),
  unassignProject: mutationReference<{ readonly projectKey: FocusProjectKey }, null>(
    "focuses:unassignProject",
  ),
  unreadCount: queryReference<{}, number>("focusNotifications:unreadCount"),
  notifications: queryReference<{ readonly limit?: number }, ReadonlyArray<FocusNotification>>(
    "focusNotifications:list",
  ),
  markAllRead: mutationReference<{}, null>("focusNotifications:markAllRead"),
} as const;

export interface FocusMutations {
  readonly create: (input: {
    readonly id: FocusId;
    readonly name: string;
    readonly iconName: string;
    readonly accentColor: string;
    readonly orderKey?: string;
  }) => Promise<Focus>;
  readonly update: (input: {
    readonly focusId: FocusId;
    readonly name?: string;
    readonly iconName?: string;
    readonly accentColor?: string;
  }) => Promise<Focus>;
  readonly reorder: (input: {
    readonly focusId: FocusId;
    readonly orderKey: string;
  }) => Promise<null>;
  readonly remove: (input: { readonly focusId: FocusId }) => Promise<null>;
  readonly assignProject: (input: {
    readonly focusId: FocusId;
    readonly projectKey: FocusProjectKey;
  }) => Promise<null>;
  readonly unassignProject: (input: { readonly projectKey: FocusProjectKey }) => Promise<null>;
  readonly markAllNotificationsRead: () => Promise<null>;
}

export const focusMutationsAtom = Atom.make<FocusMutations | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("focuses:mutations"),
);

const EMPTY_FOCUS_NOTIFICATIONS: ReadonlyArray<FocusNotification> = Object.freeze([]);

export const focusUnreadCountAtom = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("focuses:notification-unread-count"),
);

export const focusNotificationsAtom = Atom.make<ReadonlyArray<FocusNotification>>(
  EMPTY_FOCUS_NOTIFICATIONS,
).pipe(Atom.keepAlive, Atom.withLabel("focuses:notifications"));

function makeFocusMutations(client: ConvexClient): FocusMutations {
  return {
    create: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.create, input),
    update: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.update, input),
    reorder: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.reorder, input),
    remove: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.remove, input),
    assignProject: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.assignProject, input),
    unassignProject: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.unassignProject, input),
    markAllNotificationsRead: () => client.mutation(FOCUS_FUNCTION_REFERENCES.markAllRead, {}),
  };
}

export interface ActiveFocusStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export function activeFocusIdStorageKey(scope: string): string {
  return `pathway:cloud-sync/${scope}/active-focus-id`;
}

function persistedActiveFocusId(value: string | null): ActiveFocusId {
  return value === null || value === ALL_FOCUS_ID ? ALL_FOCUS_ID : FocusId.make(value);
}

export function readActiveFocusId(options: {
  readonly scope: string | null;
  readonly readModel: FocusReadModel | null;
  readonly visibleProjectKeys: ReadonlySet<string>;
  readonly storage: ActiveFocusStorage | null;
}): ActiveFocusId {
  if (options.scope === null) return ALL_FOCUS_ID;
  let persisted: string | null = null;
  try {
    persisted = options.storage?.getItem(activeFocusIdStorageKey(options.scope)) ?? null;
  } catch {
    // A blocked storage API should not make Focus selection unavailable.
  }
  const preferredId = persistedActiveFocusId(persisted);
  return options.readModel === null
    ? preferredId
    : resolveActiveFocusId({
        preferredId,
        focuses: options.readModel.focuses,
        assignments: options.readModel.assignments,
        visibleProjectKeys: options.visibleProjectKeys,
      });
}

export function writeActiveFocusId(options: {
  readonly scope: string | null;
  readonly activeFocusId: ActiveFocusId;
  readonly storage: ActiveFocusStorage | null;
}): ActiveFocusId {
  if (options.scope === null) return ALL_FOCUS_ID;
  try {
    options.storage?.setItem(activeFocusIdStorageKey(options.scope), options.activeFocusId);
  } catch {
    // The selection still applies for this render if persistence is unavailable.
  }
  return options.activeFocusId;
}

function ambientLocalStorage(): ActiveFocusStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const decodeFocusReadModel = Schema.decodeUnknownOption(FocusReadModelSchema);
const decodeFocusUnreadCount = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
);
const decodeFocusNotifications = Schema.decodeUnknownOption(Schema.Array(FocusNotificationSchema));

export const visibleFocusProjectKeysAtom = Atom.make((get): ReadonlySet<string> => {
  return new Set(
    get(environmentProjects.projectsAtom).map((project) =>
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
    ),
  );
}).pipe(Atom.withLabel("focuses:company-visible-project-keys"));

const activeFocusAccountScopeAtom = Atom.make((get) => {
  const accountId = get(managedRelaySessionAtom)?.accountId.trim();
  return accountId ? accountId : null;
}).pipe(Atom.withLabel("focuses:active-account-scope"));

const activeFocusOverridesAtom = Atom.make<ReadonlyMap<string, ActiveFocusId>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("focuses:active-overrides"),
);

export const activeFocusIdAtom = Atom.writable(
  (get) => {
    const scope = get(activeFocusAccountScopeAtom);
    const readModel = get(focusReadModelAtom);
    const visibleProjectKeys = get(visibleFocusProjectKeysAtom);
    const override = scope === null ? undefined : get(activeFocusOverridesAtom).get(scope);
    if (override !== undefined) {
      return readModel === null
        ? override
        : resolveActiveFocusId({
            preferredId: override,
            focuses: readModel.focuses,
            assignments: readModel.assignments,
            visibleProjectKeys,
          });
    }
    return readActiveFocusId({
      scope,
      readModel,
      visibleProjectKeys,
      storage: ambientLocalStorage(),
    });
  },
  (context, requestedId: ActiveFocusId) => {
    const scope = context.get(activeFocusAccountScopeAtom);
    const readModel = context.get(focusReadModelAtom);
    const activeFocusId =
      readModel === null
        ? requestedId
        : resolveActiveFocusId({
            preferredId: requestedId,
            focuses: readModel.focuses,
            assignments: readModel.assignments,
            visibleProjectKeys: context.get(visibleFocusProjectKeysAtom),
          });
    writeActiveFocusId({ scope, activeFocusId, storage: ambientLocalStorage() });
    if (scope !== null) {
      context.set(
        activeFocusOverridesAtom,
        new Map(context.get(activeFocusOverridesAtom)).set(scope, activeFocusId),
      );
    }
    context.refreshSelf();
  },
).pipe(Atom.withLabel("focuses:active-id"));

export const activeFocusProjectKeysAtom = Atom.make((get) =>
  scopedProjectKeysForFocus(get(focusAssignmentsAtom), get(activeFocusIdAtom)),
).pipe(Atom.withLabel("focuses:active-project-keys"));

export function useFocusReadModelRuntime(options: {
  readonly enabled: boolean;
  readonly accountScope: string | null;
  readonly convexUrl: string | null;
  readonly fetchToken: ConvexAuthTokenFetcher;
}): void {
  useEffect(() => {
    if (!options.enabled || options.accountScope === null || options.convexUrl === null) {
      appAtomRegistry.set(focusReadModelAtom, null);
      appAtomRegistry.set(focusMutationsAtom, null);
      appAtomRegistry.set(focusUnreadCountAtom, 0);
      appAtomRegistry.set(focusNotificationsAtom, EMPTY_FOCUS_NOTIFICATIONS);
      return;
    }

    const client = new ConvexClient(options.convexUrl);
    client.setAuth(options.fetchToken);
    const mutations = makeFocusMutations(client);
    appAtomRegistry.set(focusMutationsAtom, mutations);
    const unsubscribes = [
      client.onUpdate(
        FOCUS_FUNCTION_REFERENCES.readModel,
        {},
        (value) => {
          const decoded = decodeFocusReadModel(value);
          if (Option.isSome(decoded)) appAtomRegistry.set(focusReadModelAtom, decoded.value);
          else console.warn("Convex returned an invalid Focus read model.");
        },
        (error) => console.warn("Could not subscribe to Focus definitions.", error),
      ),
      client.onUpdate(
        FOCUS_FUNCTION_REFERENCES.unreadCount,
        {},
        (value) => {
          const decoded = decodeFocusUnreadCount(value);
          if (Option.isSome(decoded)) appAtomRegistry.set(focusUnreadCountAtom, decoded.value);
          else console.warn("Convex returned an invalid Focus notification unread count.");
        },
        (error) => console.warn("Could not subscribe to the Focus unread count.", error),
      ),
      client.onUpdate(
        FOCUS_FUNCTION_REFERENCES.notifications,
        { limit: FOCUS_NOTIFICATION_MAX_PER_USER },
        (value) => {
          const decoded = decodeFocusNotifications(value);
          if (Option.isSome(decoded)) appAtomRegistry.set(focusNotificationsAtom, decoded.value);
          else console.warn("Convex returned invalid Focus notifications.");
        },
        (error) => console.warn("Could not subscribe to Focus notifications.", error),
      ),
    ];

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (appAtomRegistry.get(focusMutationsAtom) === mutations) {
        appAtomRegistry.set(focusMutationsAtom, null);
      }
      void client.close();
      appAtomRegistry.set(focusReadModelAtom, null);
      appAtomRegistry.set(focusUnreadCountAtom, 0);
      appAtomRegistry.set(focusNotificationsAtom, EMPTY_FOCUS_NOTIFICATIONS);
    };
  }, [options.accountScope, options.convexUrl, options.enabled, options.fetchToken]);
}
