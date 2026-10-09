// @effect-diagnostics globalDate:off globalTimers:off -- Electron permission callbacks are synchronous; prompt deadlines and agent activity are read inline.
import {
  type BrowserSitePermission,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type DesktopBrowserPermissionEvent,
  resolveBrowserSitePermission,
} from "@spiritdevs/contracts";
import type { Session } from "electron";
import { ipcMain, session, webContents as electronWebContents } from "electron";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { SITE_TOOLS_ENABLED_CHANNEL } from "./GuestProtocol.ts";
import { installPreviewWebAuthnAccountPicker } from "./WebAuthn.ts";

const PREVIEW_PARTITION_PREFIX = "persist:pathway-preview-";

// `clipboard-sanitized-write` is the Electron permission behind
// `navigator.clipboard.writeText()` — note it is NOT `clipboard-write`, which is
// not a valid Electron permission name. Async clipboard writes are gated by the
// permission *check* handler (not only the request handler), so both handlers
// must allow it; otherwise built-in "Copy" buttons — e.g. the Next.js / Vercel
// error overlay — fail with `Write permission denied`. Writing is harmless, so it
// is always allowed and has no site setting.
const ALWAYS_ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
]);

/** How long a site permission prompt waits for the user before it denies. */
const PERMISSION_PROMPT_TIMEOUT_MS = 60_000;

/** How long after an agent acts in a tab its downloads still count as the agent's. */
const AGENT_ACTIVITY_WINDOW_MS = 10_000;

/**
 * The site settings an Electron permission request falls under. Anything else
 * is denied — deliberately including local-fonts: preview sessions run
 * untrusted web content, and granting it would hand every page the user's
 * installed-font fingerprint (and font bytes via FontData.blob()).
 */
export const sitePermissionsForRequest = (
  permission: string,
  mediaTypes: ReadonlyArray<string> | undefined,
): ReadonlyArray<BrowserSitePermission> => {
  switch (permission) {
    case "media": {
      const types =
        mediaTypes === undefined || mediaTypes.length === 0 ? ["video", "audio"] : mediaTypes;
      return [
        ...(types.includes("video") ? (["camera"] as const) : []),
        ...(types.includes("audio") ? (["microphone"] as const) : []),
      ];
    }
    case "geolocation":
      return ["location"];
    case "notifications":
      return ["notifications"];
    case "clipboard-read":
      return ["clipboard"];
    case "midi":
    case "midiSysex":
      return ["midi"];
    default:
      return [];
  }
};

/** Combines several settings: any block denies, all allow grants, otherwise ask. */
export const combineSitePermissionValues = (
  values: ReadonlyArray<"ask" | "allow" | "block">,
): "ask" | "allow" | "block" => {
  if (values.length === 0 || values.includes("block")) return "block";
  return values.every((value) => value === "allow") ? "allow" : "ask";
};

const originOf = (url: string | undefined): string | null => {
  if (!url || !URL.canParse(url)) return null;
  const origin = new URL(url).origin;
  return origin === "null" ? null : origin;
};

export class BrowserSessionPartitionDerivationError extends Schema.TaggedErrorClass<BrowserSessionPartitionDerivationError>()(
  "BrowserSessionPartitionDerivationError",
  {
    scope: Schema.String,
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message(): string {
    return `Failed to derive a desktop preview browser partition for scope ${this.scope}.`;
  }
}

export class BrowserSessionCreationError extends Schema.TaggedErrorClass<BrowserSessionCreationError>()(
  "BrowserSessionCreationError",
  {
    scope: Schema.String,
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create a desktop preview browser session for scope ${this.scope} (partition ${this.partition}).`;
  }
}

export class BrowserSessionStorageClearError extends Schema.TaggedErrorClass<BrowserSessionStorageClearError>()(
  "BrowserSessionStorageClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear desktop preview browser storage for partition ${this.partition}.`;
  }
}

export class BrowserSessionCacheClearError extends Schema.TaggedErrorClass<BrowserSessionCacheClearError>()(
  "BrowserSessionCacheClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear the desktop preview browser cache for partition ${this.partition}.`;
  }
}

export const BrowserSessionGetSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
]);
export type BrowserSessionGetSessionError = typeof BrowserSessionGetSessionError.Type;
export const isBrowserSessionGetSessionError = Schema.is(BrowserSessionGetSessionError);

export const BrowserSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
  BrowserSessionStorageClearError,
  BrowserSessionCacheClearError,
]);
export type BrowserSessionError = typeof BrowserSessionError.Type;
export const isBrowserSessionError = Schema.is(BrowserSessionError);

export class BrowserSession extends Context.Service<
  BrowserSession,
  {
    readonly getPartition: (
      scope?: string,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly isPartition: (partition: string) => boolean;
    readonly getSession: (scope?: string) => Effect.Effect<Session, BrowserSessionGetSessionError>;
    /** The partition a preview session was made from, as the Pathway runtime addresses it. */
    readonly partitionOf: (session: Session) => Effect.Effect<string | undefined>;
    readonly clearCookies: () => Effect.Effect<void, BrowserSessionStorageClearError>;
    readonly clearCache: () => Effect.Effect<void, BrowserSessionCacheClearError>;
    /** Clears the chosen kinds of data from every preview session. */
    readonly clearBrowsingData: (input: {
      readonly cookies: boolean;
      readonly siteData: boolean;
      readonly cache: boolean;
    }) => Effect.Effect<void, BrowserSessionStorageClearError | BrowserSessionCacheClearError>;
    /** Applies the user's browser settings to every session and open page. */
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    /** The browser settings last applied by {@link configure}. Sync for Electron callbacks. */
    readonly settings: () => ClientSettings;
    /** Runs `hook` for every preview session, existing and future. */
    readonly onSession: (hook: (browserSession: Session) => void) => Effect.Effect<void>;
    /** Mutes a page whose site has sound blocked. Called when it navigates. */
    readonly applyPagePolicy: (contents: Electron.WebContents) => void;
    readonly markAgentActivity: (webContentsId: number) => void;
    /** Whether an agent acted in this page in the last few seconds. */
    readonly isAgentActive: (webContentsId: number) => boolean;
    readonly subscribePermissionEvents: (
      listener: (event: DesktopBrowserPermissionEvent) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly respondPermission: (requestId: string, allow: boolean) => Effect.Effect<void>;
  }
>()("@spiritdevs/desktop/preview/BrowserSession") {}

export const make = Effect.gen(function* BrowserSessionMake() {
  const crypto = yield* Crypto.Crypto;
  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());
  // Electron's permission and download callbacks are synchronous, so the
  // settings and prompt state they read are plain values, not Refs.
  let currentSettings = DEFAULT_CLIENT_SETTINGS;
  const knownSessions = new Set<Session>();
  const sessionHooks = new Set<(browserSession: Session) => void>();
  const agentActivity = new Map<number, number>();
  const permissionListeners = new Set<(event: DesktopBrowserPermissionEvent) => void>();
  const pendingPermissions = new Map<string, { readonly settle: (allow: boolean) => void }>();
  let permissionSequence = 0;

  const emitPermissionEvent = (event: DesktopBrowserPermissionEvent) => {
    for (const listener of permissionListeners) listener(event);
  };

  const sitePermissionValue = (origin: string | null, permission: BrowserSitePermission) =>
    resolveBrowserSitePermission(currentSettings.browserSitePermissions, origin, permission);

  /** Asks the client to prompt for a permission set to Ask; denies when nobody answers. */
  const promptForPermission = (
    contents: Electron.WebContents,
    origin: string,
    permissions: ReadonlyArray<BrowserSitePermission>,
    callback: (allow: boolean) => void,
  ) => {
    if (permissionListeners.size === 0) {
      callback(false);
      return;
    }
    permissionSequence += 1;
    const requestId = `permission-${permissionSequence}`;
    const settle = (allow: boolean) => {
      if (!pendingPermissions.delete(requestId)) return;
      clearTimeout(timeout);
      contents.off("destroyed", onDestroyed);
      contents.off("did-start-navigation", onNavigation);
      callback(allow);
      emitPermissionEvent({ type: "settled", requestId });
    };
    const onDestroyed = () => settle(false);
    const onNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (details.isMainFrame && !details.isSameDocument) settle(false);
    };
    const timeout = setTimeout(() => settle(false), PERMISSION_PROMPT_TIMEOUT_MS);
    pendingPermissions.set(requestId, { settle });
    contents.once("destroyed", onDestroyed);
    contents.on("did-start-navigation", onNavigation);
    emitPermissionEvent({
      type: "request",
      request: { requestId, webContentsId: contents.id, origin, permissions },
    });
  };

  const installPermissionHandlers = (browserSession: Session) => {
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (ALWAYS_ALLOWED_PREVIEW_PERMISSIONS.has(permission)) return callback(true);
      const permissions = sitePermissionsForRequest(
        permission,
        details && "mediaTypes" in details ? details.mediaTypes : undefined,
      );
      const origin = originOf(details?.requestingUrl) ?? originOf(contents?.getURL());
      const decision = combineSitePermissionValues(
        permissions.map((entry) => sitePermissionValue(origin, entry)),
      );
      if (decision !== "ask" || !contents || origin === null) return callback(decision === "allow");
      promptForPermission(contents, origin, permissions, callback);
    });
    browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (ALWAYS_ALLOWED_PREVIEW_PERMISSIONS.has(permission)) return true;
      const mediaType = details && "mediaType" in details ? details.mediaType : undefined;
      const permissions = sitePermissionsForRequest(
        permission,
        mediaType === undefined || mediaType === "unknown" ? undefined : [mediaType],
      );
      const origin = originOf(requestingOrigin) ?? originOf(contents?.getURL());
      return (
        combineSitePermissionValues(
          permissions.map((entry) => sitePermissionValue(origin, entry)),
        ) === "allow"
      );
    });
  };

  // The guest preload asks synchronously before page scripts run.
  const answerSiteToolsEnabled = (event: Electron.IpcMainEvent) => {
    event.returnValue =
      knownSessions.has(event.sender.session) &&
      currentSettings.browserAgentControlEnabled &&
      currentSettings.browserSiteToolsEnabled;
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => ipcMain.on(SITE_TOOLS_ENABLED_CHANNEL, answerSiteToolsEnabled)),
    () => Effect.sync(() => ipcMain.off(SITE_TOOLS_ENABLED_CHANNEL, answerSiteToolsEnabled)),
  );

  const applyPagePolicy = (contents: Electron.WebContents) => {
    if (contents.isDestroyed()) return;
    contents.setAudioMuted(sitePermissionValue(originOf(contents.getURL()), "sound") === "block");
  };

  const getPartition = Effect.fn("BrowserSession.getPartition")(function* (scope = "shared") {
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(scope)).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserSessionPartitionDerivationError({
            scope,
            cause,
          }),
      ),
    );
    return `${PREVIEW_PARTITION_PREFIX}${Encoding.encodeHex(digest).slice(0, 20)}`;
  });

  const getSession = Effect.fn("BrowserSession.getSession")(function* (scope = "shared") {
    const partition = yield* getPartition(scope);
    return yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) => {
      const existing = sessions.get(partition);
      if (existing) return Effect.succeed([existing, sessions] as const);
      return Effect.try({
        try: () => {
          const browserSession = session.fromPartition(partition);
          installPreviewWebAuthnAccountPicker(browserSession);
          const userAgent = browserSession
            .getUserAgent()
            .replace(/Electron\/[\d.]+ /, "")
            .replace(/\s*pathway\/[\d.]+/, "");
          browserSession.setUserAgent(userAgent);
          knownSessions.add(browserSession);
          installPermissionHandlers(browserSession);
          for (const hook of sessionHooks) hook(browserSession);
          const next = new Map(sessions);
          next.set(partition, browserSession);
          return [browserSession, next] as const;
        },
        catch: (cause) =>
          new BrowserSessionCreationError({
            scope,
            partition,
            cause,
          }),
      });
    });
  });

  return BrowserSession.of({
    getPartition,
    isPartition: (partition) => partition.startsWith(PREVIEW_PARTITION_PREFIX),
    getSession,
    partitionOf: Effect.fn("BrowserSession.partitionOf")(function* (browserSession: Session) {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      return [...sessions].find(([, candidate]) => candidate === browserSession)?.[0];
    }),
    clearCookies: Effect.fn("BrowserSession.clearCookies")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].map(([partition, browserSession]) =>
          Effect.tryPromise({
            try: () =>
              browserSession.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "serviceworkers"],
              }),
            catch: (cause) =>
              new BrowserSessionStorageClearError({
                partition,
                cause,
              }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
    clearBrowsingData: Effect.fn("BrowserSession.clearBrowsingData")(function* (input) {
      const storages: Array<NonNullable<Electron.ClearStorageDataOptions["storages"]>[number]> = [
        ...(input.cookies ? (["cookies"] as const) : []),
        ...(input.siteData
          ? ([
              "filesystem",
              "indexdb",
              "localstorage",
              "shadercache",
              "serviceworkers",
              "cachestorage",
            ] as const)
          : []),
      ];
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].flatMap(([partition, browserSession]) => [
          ...(storages.length === 0
            ? []
            : [
                Effect.tryPromise({
                  try: () => browserSession.clearStorageData({ storages }),
                  catch: (cause) => new BrowserSessionStorageClearError({ partition, cause }),
                }),
              ]),
          ...(input.cache
            ? [
                Effect.tryPromise({
                  try: () => browserSession.clearCache(),
                  catch: (cause) => new BrowserSessionCacheClearError({ partition, cause }),
                }),
              ]
            : []),
        ]),
        { concurrency: "unbounded", discard: true },
      );
    }),
    configure: Effect.fn("BrowserSession.configure")(function* (settings: ClientSettings) {
      currentSettings = settings;
      const sessions = new Set((yield* SynchronizedRef.get(sessionsRef)).values());
      for (const contents of electronWebContents.getAllWebContents()) {
        if (sessions.has(contents.session)) applyPagePolicy(contents);
      }
    }),
    settings: () => currentSettings,
    onSession: Effect.fn("BrowserSession.onSession")(function* (hook) {
      sessionHooks.add(hook);
      for (const browserSession of (yield* SynchronizedRef.get(sessionsRef)).values()) {
        hook(browserSession);
      }
    }),
    applyPagePolicy,
    markAgentActivity: (webContentsId) => {
      agentActivity.set(webContentsId, Date.now());
    },
    isAgentActive: (webContentsId) => {
      const at = agentActivity.get(webContentsId);
      return at !== undefined && Date.now() - at <= AGENT_ACTIVITY_WINDOW_MS;
    },
    subscribePermissionEvents: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => permissionListeners.add(listener)),
        () => Effect.sync(() => permissionListeners.delete(listener)),
      ).pipe(Effect.asVoid),
    respondPermission: (requestId, allow) =>
      Effect.sync(() => pendingPermissions.get(requestId)?.settle(allow)),
    clearCache: Effect.fn("BrowserSession.clearCache")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].map(([partition, browserSession]) =>
          Effect.tryPromise({
            try: () => browserSession.clearCache(),
            catch: (cause) =>
              new BrowserSessionCacheClearError({
                partition,
                cause,
              }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
}).pipe(Effect.withSpan("BrowserSession.make"));

export const layer = Layer.effect(BrowserSession, make);
