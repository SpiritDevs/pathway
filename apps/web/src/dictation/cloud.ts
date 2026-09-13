import { useAuth } from "@clerk/react";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  DictationDictionaryList,
  dictationDictionaryError,
  type DictationCommand,
} from "@spiritdevs/contracts/dictation";
import { resolveCloudSyncConvexUrl } from "../cloud/publicConfig";
import { makeClerkConvexTokenFetcher } from "../cloud/syncTransportAuth";

type Dictionary = readonly DictationDictionaryList[];
const read = makeFunctionReference<
  "query",
  Record<string, never>,
  { revision: number; lists: Dictionary }
>("dictationDictionary:read");
const save = makeFunctionReference<"mutation", { revision: number; lists: Dictionary }, number>(
  "dictationDictionary:save",
);
const decode = Schema.decodeUnknownSync(
  Schema.Struct({ revision: Schema.Number, lists: Schema.Array(DictationDictionaryList) }),
);
let saveCurrent: ((lists: Dictionary, base: Dictionary) => Promise<void>) | null = null;
let accountQueue = Promise.resolve();

export function saveDictationDictionary(lists: Dictionary, base: Dictionary): Promise<void> {
  const error = dictationDictionaryError(lists);
  if (error) return Promise.reject(new Error(error));
  if (!saveCurrent || !navigator.onLine)
    return Promise.reject(new Error("Connect to Pathway Cloud to edit your dictionary."));
  return saveCurrent(lists, base);
}

/** Keeps native dictation bound to the live account even while its settings page is closed. */
export function DictationAccountCoordinator() {
  const navigate = useNavigate();
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const accountId = isLoaded && isSignedIn ? (userId ?? null) : null;
  const url = resolveCloudSyncConvexUrl();
  useEffect(
    () =>
      window.desktopBridge?.dictation?.onNavigate?.((page) => {
        void navigate({ to: `/settings/dictation/${page}` });
      }),
    [navigate],
  );
  useEffect(() => {
    const bridge = window.desktopBridge?.dictation;
    if (!bridge) return;
    let active = true;
    let revision = 0;
    let latest: Dictionary | null = null;
    let unsubscribe = () => {};
    let unsubscribeConnection = () => {};
    let lastSent: { lists: Dictionary; connected: boolean } | null = null;
    let client: ConvexClient | null = null;
    const send = async (command: DictationCommand) => {
      if (active) await bridge.execute(command);
    };
    const connected = (value: boolean) => {
      if (!latest || !active || (lastSent?.lists === latest && lastSent.connected === value))
        return;
      lastSent = { lists: latest, connected: value };
      void send({ type: "dictionary", lists: latest, connected: value }).catch(() => {
        lastSent = null;
      });
    };
    const onOffline = () => connected(false);
    const onOnline = () => connected(client?.connectionState().isWebSocketConnected === true);
    const start = accountQueue.then(async () => {
      if (!active) return;
      await bridge.execute({ type: "account", accountId });
      if (!active || !accountId || !url) return;
      client = new ConvexClient(url);
      client.setAuth((args) => makeClerkConvexTokenFetcher(tokenRef.current)(args));
      unsubscribeConnection = client.subscribeToConnectionState((state) =>
        connected(navigator.onLine && state.isWebSocketConnected),
      );
      unsubscribe = client.onUpdate(
        read,
        {},
        (value) => {
          if (!active) return;
          try {
            const data = decode(value);
            if (data.revision < revision) return;
            revision = data.revision;
            latest = data.lists;
            connected(navigator.onLine);
          } catch {
            connected(false);
          }
        },
        () => connected(false),
      );
      saveCurrent = async (lists, base) => {
        if (!active || !client || !latest || !client.connectionState().isWebSocketConnected)
          throw new Error("Connect to Pathway Cloud to edit your dictionary.");
        if (JSON.stringify(base) !== JSON.stringify(latest))
          throw new Error(
            "Your dictionary changed on another computer. Copy any edits you want to keep, then discard changes to load the latest dictionary.",
          );
        const savedRevision = await client.mutation(save, { revision, lists });
        if (!active || savedRevision < revision) return;
        revision = savedRevision;
        latest = lists;
        connected(navigator.onLine && client.connectionState().isWebSocketConnected);
      };
    });
    accountQueue = start.catch(() => {});
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      active = false;
      saveCurrent = null;
      unsubscribe();
      unsubscribeConnection();
      if (client) void client.close();
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      accountQueue = accountQueue
        .then(() => bridge.execute({ type: "account", accountId: null }))
        .then(
          () => {},
          () => {},
        );
    };
  }, [accountId, url]);
  return null;
}
