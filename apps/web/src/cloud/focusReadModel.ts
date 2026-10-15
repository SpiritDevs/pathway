import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import {
  ALL_FOCUS_ID,
  CONVERSATIONS_FOCUS_ID,
  focusAssignmentsAtom,
  focusIdForThread,
  focusListAtom,
  focusNotificationProjectKey,
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
  type FocusAssignment,
  type FocusNotification,
  type FocusReadModel,
  type FocusThreadSortOrder,
} from "@spiritdevs/contracts/focus";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import {
  scopedProjectKey,
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@spiritdevs/client-runtime/environment";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { allEnvironmentShellsBootstrappedAtom } from "../state/shell";
import { companyThreadReadinessAtom, type ThreadListReadiness } from "./companyReadiness";
import {
  subscribeThreadAlertPolicies,
  threadAlertNotificationsReadyAtom,
} from "../threadAlerts/state";
import type { ConvexAuthTokenFetcher } from "./syncTransport";
import { readCloudSyncReset } from "./syncReset";

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
      readonly projectKeys?: ReadonlyArray<FocusProjectKey>;
      readonly includeConversations?: boolean;
    },
    Focus
  >("focuses:create"),
  update: mutationReference<
    {
      readonly focusId: FocusId;
      readonly name?: string;
      readonly iconName?: string;
      readonly accentColor?: string;
      readonly includeConversations?: boolean;
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
  setViewPreference: mutationReference<
    {
      readonly focusId: string;
      readonly sortOrder?: FocusThreadSortOrder;
      readonly collapsiblePinned?: boolean;
    },
    null
  >("focuses:setViewPreference"),
  unreadCount: queryReference<{}, number>("focusNotifications:unreadCount"),
  notifications: queryReference<{ readonly limit?: number }, ReadonlyArray<FocusNotification>>(
    "focusNotifications:list",
  ),
  clearAll: mutationReference<{}, null>("focusNotifications:clearAll"),
  markAllSeen: mutationReference<{}, null>("focusNotifications:markAllSeen"),
  markAllRead: mutationReference<{}, null>("focusNotifications:markAllRead"),
  markRead: mutationReference<{ eventId: string }, null>("focusNotifications:markRead"),
} as const;

export interface FocusMutations {
  readonly create: (input: {
    readonly id: FocusId;
    readonly name: string;
    readonly iconName: string;
    readonly accentColor: string;
    readonly orderKey?: string;
    readonly projectKeys?: ReadonlyArray<FocusProjectKey>;
    readonly includeConversations?: boolean;
  }) => Promise<Focus>;
  readonly update: (input: {
    readonly focusId: FocusId;
    readonly name?: string;
    readonly iconName?: string;
    readonly accentColor?: string;
    readonly includeConversations?: boolean;
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
  /** focusId is a Focus id, "all", or "conversations". */
  readonly setViewPreference: (input: {
    readonly focusId: string;
    readonly sortOrder?: FocusThreadSortOrder;
    readonly collapsiblePinned?: boolean;
  }) => Promise<null>;
  readonly clearAllNotifications: () => Promise<null>;
  readonly markAllNotificationsSeen: () => Promise<null>;
  readonly markAllNotificationsRead: () => Promise<null>;
  readonly markNotificationRead?: (eventId: string) => Promise<null>;
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

// Notifications acknowledged on this device ahead of Cloud, so a slow or failed
// markRead never strands a thread the user settled by hand.
const locallyReadNotificationIdsAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
);

export const unreadNotificationThreadKeysAtom = Atom.make((get) => {
  const locallyRead = get(locallyReadNotificationIdsAtom);
  return new Set(
    get(focusNotificationsAtom)
      .filter((notification) => !notification.isRead && !locallyRead.has(notification.eventId))
      .map((notification) =>
        scopedThreadKey(scopeThreadRef(notification.environmentId, notification.threadId)),
      ),
  );
});

export const threadHasUnreadNotificationAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => get(unreadNotificationThreadKeysAtom).has(threadKey)),
);

export function readThreadHasUnreadNotification(threadKey: string): boolean {
  return appAtomRegistry.get(unreadNotificationThreadKeysAtom).has(threadKey);
}

/** Acknowledges a thread's notifications without opening it, as settling it from a list does. */
export function markThreadNotificationsRead(threadKey: string): void {
  const unread = appAtomRegistry
    .get(focusNotificationsAtom)
    .filter(
      (notification) =>
        !notification.isRead &&
        scopedThreadKey(scopeThreadRef(notification.environmentId, notification.threadId)) ===
          threadKey,
    );
  if (unread.length === 0) return;
  appAtomRegistry.update(
    locallyReadNotificationIdsAtom,
    (ids) => new Set([...ids, ...unread.map((notification) => notification.eventId)]),
  );
  const markRead = appAtomRegistry.get(focusMutationsAtom)?.markNotificationRead;
  for (const notification of unread) {
    void markRead?.(notification.eventId).catch((error: unknown) => {
      console.warn("Could not mark thread notification as read.", error);
    });
  }
}

function makeFocusMutations(client: ConvexClient): FocusMutations {
  return {
    create: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.create, input),
    update: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.update, input),
    reorder: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.reorder, input),
    remove: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.remove, input),
    assignProject: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.assignProject, input),
    unassignProject: (input) => client.mutation(FOCUS_FUNCTION_REFERENCES.unassignProject, input),
    setViewPreference: ({ focusId, sortOrder, collapsiblePinned }) =>
      client.mutation(FOCUS_FUNCTION_REFERENCES.setViewPreference, {
        focusId,
        ...(sortOrder === undefined ? {} : { sortOrder }),
        ...(collapsiblePinned === undefined ? {} : { collapsiblePinned }),
      }),
    clearAllNotifications: () => client.mutation(FOCUS_FUNCTION_REFERENCES.clearAll, {}),
    markAllNotificationsSeen: () => client.mutation(FOCUS_FUNCTION_REFERENCES.markAllSeen, {}),
    markAllNotificationsRead: () => client.mutation(FOCUS_FUNCTION_REFERENCES.markAllRead, {}),
    markNotificationRead: (eventId) =>
      client.mutation(FOCUS_FUNCTION_REFERENCES.markRead, { eventId }),
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
  readonly projectsReady?: boolean;
}): ActiveFocusId {
  if (options.scope === null) return ALL_FOCUS_ID;
  let persisted: string | null = null;
  try {
    persisted = options.storage?.getItem(activeFocusIdStorageKey(options.scope)) ?? null;
  } catch {
    // A blocked storage API should not make Focus selection unavailable.
  }
  const preferredId = persistedActiveFocusId(persisted);
  return options.readModel === null || options.projectsReady === false
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

export function persistActiveFocusSelection(options: {
  readonly scope: string | null;
  readonly requestedId: ActiveFocusId;
  readonly overrides: ReadonlyMap<string, ActiveFocusId>;
  readonly storage: ActiveFocusStorage | null;
}): ReadonlyMap<string, ActiveFocusId> {
  writeActiveFocusId({
    scope: options.scope,
    activeFocusId: options.requestedId,
    storage: options.storage,
  });
  if (options.scope === null) return options.overrides;
  return new Map(options.overrides).set(options.scope, options.requestedId);
}

/** Per Focus tab, the newest notification time the user has had in view on this device. */
export type FocusSeenAt = Readonly<Record<string, number>>;

const EMPTY_FOCUS_SEEN_AT: FocusSeenAt = Object.freeze({});

export function focusSeenAtStorageKey(scope: string): string {
  return `pathway:cloud-sync/${scope}/focus-seen-at`;
}

const decodeFocusSeenAt = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
);

export function readFocusSeenAt(scope: string, storage: ActiveFocusStorage | null): FocusSeenAt {
  try {
    const raw = storage?.getItem(focusSeenAtStorageKey(scope));
    return raw
      ? Option.getOrElse(decodeFocusSeenAt(raw), () => EMPTY_FOCUS_SEEN_AT)
      : EMPTY_FOCUS_SEEN_AT;
  } catch {
    return EMPTY_FOCUS_SEEN_AT;
  }
}

function notificationFocusIds(input: {
  readonly notifications: ReadonlyArray<FocusNotification>;
  readonly focuses: ReadonlyArray<Pick<Focus, "id" | "includeConversations">>;
  readonly assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>;
}): ReadonlyArray<readonly [FocusNotification, ActiveFocusId]> {
  const focusIdByProjectKey = new Map(
    input.assignments.map((assignment) => [assignment.projectKey, assignment.focusId] as const),
  );
  return input.notifications.map((notification) => [
    notification,
    focusIdForThread({
      projectKey: focusNotificationProjectKey(notification),
      activeFocusId: ALL_FOCUS_ID,
      focuses: input.focuses,
      focusIdByProjectKey,
    }),
  ]);
}

/**
 * Raises a Focus's seen mark to the newest notification among those its view displayed, and drops
 * marks for Focuses no longer in `knownFocuses`. Returns `seenAt` itself when nothing changed.
 * The mark is a single timestamp, so it stays put while any unread notification of the Focus newer
 * than it is outside `inView`: advancing past a visible one would cover the hidden one too.
 */
export function markFocusSeen(input: {
  readonly seenAt: FocusSeenAt;
  readonly focusId: ActiveFocusId;
  readonly notifications: ReadonlyArray<FocusNotification>;
  readonly focuses: ReadonlyArray<Pick<Focus, "id" | "includeConversations">>;
  readonly assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>;
  /** The loaded Focus definitions, or null while they are unknown and nothing can be pruned. */
  readonly knownFocuses: ReadonlyArray<Pick<Focus, "id">> | null;
  /** Whether the view can show a notification's thread; omitted when it shows the whole Focus. */
  readonly inView?: (notification: FocusNotification) => boolean;
}): FocusSeenAt {
  const mark = input.seenAt[input.focusId] ?? 0;
  let newest = mark;
  if (input.focusId !== ALL_FOCUS_ID) {
    for (const [notification, focusId] of notificationFocusIds(input)) {
      if (focusId !== input.focusId || notification.createdAt <= mark) continue;
      if (!notification.isRead && input.inView?.(notification) === false) {
        newest = mark;
        break;
      }
      newest = Math.max(newest, notification.createdAt);
    }
  }
  const known = input.knownFocuses;
  const keep = (id: string) =>
    known === null || id === CONVERSATIONS_FOCUS_ID || known.some((focus) => focus.id === id);
  const ids = Object.keys(input.seenAt);
  if (newest === (input.seenAt[input.focusId] ?? 0) && ids.every(keep)) return input.seenAt;
  const next: Record<string, number> = {};
  for (const id of ids) if (keep(id)) next[id] = input.seenAt[id]!;
  if (newest > 0) next[input.focusId] = newest;
  return next;
}

/**
 * Focus tabs holding an unread notification newer than anything that Focus's view has displayed
 * on this device. The open Focus and All never carry the dot.
 */
export function unseenFocusIds(input: {
  readonly notifications: ReadonlyArray<FocusNotification>;
  readonly locallyRead: ReadonlySet<string>;
  readonly focuses: ReadonlyArray<Pick<Focus, "id" | "includeConversations">>;
  readonly assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>;
  readonly activeFocusId: ActiveFocusId;
  readonly seenAt: FocusSeenAt;
}): ReadonlySet<ActiveFocusId> {
  const unseen = new Set<ActiveFocusId>();
  for (const [notification, focusId] of notificationFocusIds(input)) {
    if (
      focusId !== ALL_FOCUS_ID &&
      focusId !== input.activeFocusId &&
      !notification.isRead &&
      !input.locallyRead.has(notification.eventId) &&
      notification.createdAt > (input.seenAt[focusId] ?? 0)
    ) {
      unseen.add(focusId);
    }
  }
  return unseen;
}

function ambientLocalStorage(): ActiveFocusStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function focusReadModelStorageKey(scope: string, convexUrl: string): string {
  return `pathway:cloud-sync/${scope}/focus-read-model/${encodeURIComponent(convexUrl)}`;
}

export function readCachedFocusReadModel(
  scope: string,
  convexUrl: string,
  storage: ActiveFocusStorage | null,
): FocusReadModel | null {
  try {
    if (readCloudSyncReset(scope)) return null;
    const raw = storage?.getItem(focusReadModelStorageKey(scope, convexUrl));
    return raw ? Option.getOrNull(decodeCachedFocusReadModel(raw)) : null;
  } catch {
    return null;
  }
}

const decodeCachedFocusReadModel = Schema.decodeUnknownOption(
  Schema.fromJsonString(FocusReadModelSchema),
);
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

const focusReadModelOwnerAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);
const focusReadModelErrorAtom = Atom.make(false).pipe(Atom.keepAlive);
export const focusReadModelReadinessAtom = Atom.make((get): ThreadListReadiness => {
  if (get(focusReadModelOwnerAtom) !== get(activeFocusAccountScopeAtom)) return "loading";
  if (get(focusReadModelAtom) !== null) return "ready";
  return get(focusReadModelErrorAtom) ? "error" : "loading";
});

const activeFocusOverridesAtom = Atom.make<ReadonlyMap<string, ActiveFocusId>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("focuses:active-overrides"),
);

const focusSeenAtOverridesAtom = Atom.make<ReadonlyMap<string, FocusSeenAt>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("focuses:seen-at-overrides"),
);

/** What the thread sidebar currently shows of the active Focus. */
export interface FocusView {
  readonly focusId: ActiveFocusId;
  /** The notification snapshot the view rendered with. */
  readonly notifications: ReadonlyArray<FocusNotification>;
  /** The loaded thread list is on screen in a visible page. */
  readonly shown: boolean;
  /** Search or the project picker hides part of the Focus. */
  readonly narrowed: boolean;
  /** Whether the active company's view can show a notification's thread. */
  readonly inView: (notification: FocusNotification) => boolean;
}

/**
 * Each Focus's seen mark. Write the Focus view whenever it changes; only a shown, unnarrowed view
 * acknowledges, and only the notifications it rendered. Selecting a Focus alone acknowledges nothing.
 */
export const focusSeenAtAtom = Atom.writable(
  (get): FocusSeenAt => {
    const scope = get(activeFocusAccountScopeAtom);
    if (scope === null) return EMPTY_FOCUS_SEEN_AT;
    return (
      get(focusSeenAtOverridesAtom).get(scope) ?? readFocusSeenAt(scope, ambientLocalStorage())
    );
  },
  (context, view: FocusView) => {
    const scope = context.get(activeFocusAccountScopeAtom);
    if (scope === null || !view.shown || view.narrowed) return;
    const seenAt = context.get(focusSeenAtAtom);
    const nextSeenAt = markFocusSeen({
      seenAt,
      focusId: view.focusId,
      notifications: view.notifications,
      focuses: context.get(focusListAtom),
      assignments: context.get(focusAssignmentsAtom),
      knownFocuses:
        context.get(focusReadModelReadinessAtom) === "ready" ? context.get(focusListAtom) : null,
      inView: view.inView,
    });
    if (nextSeenAt === seenAt) return;
    try {
      ambientLocalStorage()?.setItem(focusSeenAtStorageKey(scope), JSON.stringify(nextSeenAt));
    } catch {
      // The mark still applies for this session if persistence is unavailable.
    }
    context.set(
      focusSeenAtOverridesAtom,
      new Map(context.get(focusSeenAtOverridesAtom)).set(scope, nextSeenAt),
    );
  },
).pipe(Atom.withLabel("focuses:seen-at"));

export const activeFocusIdAtom = Atom.writable(
  (get) => {
    const scope = get(activeFocusAccountScopeAtom);
    const readModel = get(focusReadModelOwnerAtom) === scope ? get(focusReadModelAtom) : null;
    const projectsReady =
      get(companyThreadReadinessAtom) === "ready" && get(allEnvironmentShellsBootstrappedAtom);
    const visibleProjectKeys = get(visibleFocusProjectKeysAtom);
    const override = scope === null ? undefined : get(activeFocusOverridesAtom).get(scope);
    if (override !== undefined) {
      return readModel === null || !projectsReady
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
      projectsReady,
      storage: ambientLocalStorage(),
    });
  },
  (context, requestedId: ActiveFocusId) => {
    const scope = context.get(activeFocusAccountScopeAtom);
    const overrides = persistActiveFocusSelection({
      scope,
      requestedId,
      overrides: context.get(activeFocusOverridesAtom),
      storage: ambientLocalStorage(),
    });
    if (scope !== null) {
      context.set(activeFocusOverridesAtom, overrides);
    }
    context.refreshSelf();
  },
).pipe(Atom.withLabel("focuses:active-id"));

export const unseenFocusIdsAtom = Atom.make((get) =>
  unseenFocusIds({
    notifications: get(focusNotificationsAtom),
    locallyRead: get(locallyReadNotificationIdsAtom),
    focuses: get(focusListAtom),
    assignments: get(focusAssignmentsAtom),
    activeFocusId: get(activeFocusIdAtom),
    seenAt: get(focusSeenAtAtom),
  }),
).pipe(Atom.withLabel("focuses:unseen-ids"));

export const activeFocusProjectKeysAtom = Atom.make((get) =>
  scopedProjectKeysForFocus(get(focusAssignmentsAtom), get(activeFocusIdAtom)),
).pipe(Atom.withLabel("focuses:active-project-keys"));

export function useFocusReadModelRuntime(options: {
  readonly enabled: boolean;
  readonly accountScope: string | null;
  readonly convexUrl: string | null;
  readonly fetchToken: ConvexAuthTokenFetcher;
}): void {
  // Restarting a subscription for a new token keeps the same account's last complete view.
  // Changing identity/deployment or unmounting the runtime still clears it.
  useEffect(() => {
    appAtomRegistry.set(focusReadModelOwnerAtom, options.enabled ? options.accountScope : null);
    appAtomRegistry.set(
      focusReadModelAtom,
      options.enabled && options.accountScope && options.convexUrl
        ? readCachedFocusReadModel(options.accountScope, options.convexUrl, ambientLocalStorage())
        : null,
    );
    appAtomRegistry.set(focusReadModelErrorAtom, false);
    return () => {
      appAtomRegistry.set(focusReadModelOwnerAtom, null);
      appAtomRegistry.set(focusReadModelAtom, null);
      appAtomRegistry.set(focusUnreadCountAtom, 0);
      appAtomRegistry.set(focusNotificationsAtom, EMPTY_FOCUS_NOTIFICATIONS);
      appAtomRegistry.set(threadAlertNotificationsReadyAtom, false);
    };
  }, [options.accountScope, options.convexUrl, options.enabled]);
  useEffect(() => {
    if (!options.enabled || options.accountScope === null || options.convexUrl === null) {
      appAtomRegistry.set(focusReadModelAtom, null);
      appAtomRegistry.set(focusMutationsAtom, null);
      appAtomRegistry.set(focusUnreadCountAtom, 0);
      appAtomRegistry.set(focusNotificationsAtom, EMPTY_FOCUS_NOTIFICATIONS);
      appAtomRegistry.set(threadAlertNotificationsReadyAtom, false);
      return;
    }

    let active = true;
    const client = new ConvexClient(options.convexUrl);
    client.setAuth(options.fetchToken);
    const mutations = makeFocusMutations(client);
    appAtomRegistry.set(focusMutationsAtom, mutations);
    const unsubscribes = [
      subscribeThreadAlertPolicies(client, options.accountScope, focusNotificationsAtom),
      client.onUpdate(
        FOCUS_FUNCTION_REFERENCES.readModel,
        {},
        (value) => {
          if (!active) return;
          const decoded = decodeFocusReadModel(value);
          if (Option.isSome(decoded)) {
            appAtomRegistry.set(focusReadModelAtom, decoded.value);
            appAtomRegistry.set(focusReadModelErrorAtom, false);
            try {
              ambientLocalStorage()?.setItem(
                focusReadModelStorageKey(options.accountScope!, options.convexUrl!),
                JSON.stringify(value),
              );
            } catch {
              // Cached definitions are optional; the live subscription remains authoritative.
            }
          } else {
            appAtomRegistry.set(focusReadModelErrorAtom, true);
            console.warn("Convex returned an invalid Focus read model.");
          }
        },
        (error) => {
          if (!active) return;
          appAtomRegistry.set(focusReadModelErrorAtom, true);
          console.warn("Could not subscribe to Focus definitions.", error);
        },
      ),
      client.onUpdate(
        FOCUS_FUNCTION_REFERENCES.unreadCount,
        {},
        (value) => {
          if (!active) return;
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
          if (!active) return;
          const decoded = decodeFocusNotifications(value);
          if (Option.isSome(decoded)) {
            appAtomRegistry.set(focusNotificationsAtom, decoded.value);
            appAtomRegistry.set(threadAlertNotificationsReadyAtom, true);
          } else {
            appAtomRegistry.set(threadAlertNotificationsReadyAtom, false);
            console.warn("Convex returned invalid Focus notifications.");
          }
        },
        (error) => {
          if (!active) return;
          appAtomRegistry.set(threadAlertNotificationsReadyAtom, false);
          console.warn("Could not subscribe to Focus notifications.", error);
        },
      ),
    ];

    return () => {
      active = false;
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (appAtomRegistry.get(focusMutationsAtom) === mutations) {
        appAtomRegistry.set(focusMutationsAtom, null);
      }
      void client.close();
    };
  }, [options.accountScope, options.convexUrl, options.enabled, options.fetchToken]);
}
