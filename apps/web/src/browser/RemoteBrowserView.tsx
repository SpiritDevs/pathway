import type {
  PreviewRemoteCommand,
  PreviewRemoteResult,
  PreviewRemoteTab,
  ScopedThreadRef,
} from "@spiritdevs/contracts";
import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { useCallback, useEffect, useRef, useState } from "react";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { normalizePreviewUrl } from "@spiritdevs/shared/preview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { PreviewEmptyState } from "~/components/preview/PreviewEmptyState";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironment, useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useThreadProjection } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { RemoteBrowserStream } from "./RemoteBrowserStream";
import { useRemoteBrowserSelectedTabId, useRemoteBrowserStore } from "./remoteBrowserStore";

/**
 * The thread environment's own browser, streamed to this client. Its `localhost`
 * is the environment, and the agent's preview tools drive the same tabs, so the
 * user watches the agent live and can take control from any client.
 */
export function RemoteBrowserView({
  threadRef,
  visible,
  configuredUrls,
}: {
  threadRef: ScopedThreadRef;
  visible: boolean;
  configuredUrls?: ReadonlyArray<string> | undefined;
}) {
  const environmentLabel = useEnvironment(threadRef.environmentId)?.label ?? "Environment";
  const command = useAtomCommand(previewEnvironment.remoteCommand);
  const thread = useThreadProjection(threadRef)?.projection;
  const takeover = thread?.thread.browserTakeover;
  const requestTakeover = useAtomCommand(threadEnvironment.requestBrowserTakeover);
  // Takeover status and its controls live in the thread's takeover banner. This
  // is only the way in when an interaction is refused because the agent is working.
  const canRequestTakeover =
    (!takeover || ["completed", "cancelled"].includes(takeover.status)) &&
    thread?.runs.some((run) => ["preparing", "starting", "running"].includes(run.status));
  const [state, setState] = useState<PreviewRemoteResult>({ tabs: [], selectedTabId: null });
  const selectedId = useRemoteBrowserSelectedTabId(threadRef);
  const threadKey = scopedThreadKey(threadRef);
  const setSelectedId = useCallback(
    (tabId: string | null) => useRemoteBrowserStore.getState().select(threadRef, tabId),
    // threadKey stands in for threadRef, whose identity churns on every thread update.
    [threadKey],
  );
  const [hostReady, setHostReady] = useState(false);
  const [address, setAddress] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const baseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const selected =
    state.tabs.find((tab) => tab.tabId === selectedId) ??
    state.tabs.find((tab) => tab.tabId === state.selectedTabId) ??
    state.tabs[0];
  const run = useCallback(
    async (input: PreviewRemoteCommand) => {
      if (input.action !== "list") {
        setBusy(true);
        setError(undefined);
      }
      try {
        const result = await command({ environmentId: threadRef.environmentId, input });
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Browser command failed.");
          return false;
        }
        setState((previous) => ({
          ...result.value,
          ...((result.value.artifact ?? previous.artifact)
            ? { artifact: result.value.artifact ?? previous.artifact }
            : {}),
        }));
        if (input.action === "open") setSelectedId(result.value.selectedTabId);
        return true;
      } finally {
        if (input.action !== "list") setBusy(false);
      }
    },
    [command, setSelectedId, threadRef.environmentId],
  );
  // Watching the remote browser routes the agent's browsing here too, so the
  // user and the agent look at the same page. The claim is best effort: a
  // takeover held elsewhere must not stop anyone from watching.
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    void command({
      environmentId: threadRef.environmentId,
      input: { action: "selectHost", threadId: threadRef.threadId, host: "environment" },
    }).then((result) => {
      if (disposed) return;
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "The agent is still browsing elsewhere; you can watch this browser.",
        );
      }
      setHostReady(true);
      void run({ action: "list", threadId: threadRef.threadId });
    });
    return () => {
      disposed = true;
    };
  }, [visible, command, run, threadRef.environmentId, threadRef.threadId]);
  const pendingUrl = useRemoteBrowserStore(
    (store) => store.byThreadKey[threadKey]?.pendingUrl ?? null,
  );
  const openUrl = useCallback(
    (url: string) => {
      void run({ action: "open", threadId: threadRef.threadId, url }).then((opened) => {
        if (opened) recordVisitForThread(threadRef, url);
      });
    },
    // threadKey stands in for threadRef, whose identity churns on every thread update.
    [run, threadKey],
  );
  useEffect(() => {
    if (!visible || !hostReady || pendingUrl === null) return;
    const url = useRemoteBrowserStore.getState().takePendingUrl(threadRef);
    if (url !== null) openUrl(url);
    // threadKey stands in for threadRef, whose identity churns on every thread update.
  }, [visible, hostReady, pendingUrl, openUrl, threadKey]);
  useEffect(() => {
    setAddress(selected?.url ?? "");
  }, [selected?.tabId, selected?.url]);
  useEffect(() => {
    useRemoteBrowserStore
      .getState()
      .setPage(
        threadRef,
        selected ? { tabId: selected.tabId, url: selected.url, title: selected.title } : null,
      );
    // threadKey stands in for threadRef, whose identity churns on every thread update.
  }, [threadKey, selected?.tabId, selected?.url, selected?.title]);
  const lastTabs = useRef("");
  const lastMetadataRevision = useRef<number | undefined>(undefined);
  const receiveTabs = useCallback(
    (tabs: ReadonlyArray<PreviewRemoteTab>, metadataRevision?: number) => {
      const encoded = JSON.stringify(tabs);
      if (
        encoded === lastTabs.current &&
        (metadataRevision === undefined || metadataRevision === lastMetadataRevision.current)
      )
        return;
      lastTabs.current = encoded;
      lastMetadataRevision.current = metadataRevision;
      setState((previous) => ({ ...previous, tabs }));
      void run({ action: "list", threadId: threadRef.threadId });
    },
    [run, threadRef.threadId],
  );
  const target = selected ? { threadId: threadRef.threadId, tabId: selected.tabId } : null;
  const takeControl = async () => {
    const result = await requestTakeover({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setError(
      result._tag === "Failure"
        ? "Could not take control of the browser. Check the task status and try again."
        : undefined,
    );
  };
  const artifactUrl = state.artifact && baseUrl ? new URL(state.artifact.url, baseUrl).href : null;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={`Remote browser on ${environmentLabel}`}
    >
      <div className="flex items-center gap-1 overflow-x-auto border-b p-1">
        <span
          className="shrink-0 px-1 text-xs font-medium text-muted-foreground"
          title="Runs on the thread's environment, so localhost is that machine"
        >
          Remote · {environmentLabel}
        </span>
        {state.tabs.map((tab) => (
          <div key={tab.tabId} className="flex shrink-0 items-center rounded border">
            <button
              type="button"
              aria-pressed={selected?.tabId === tab.tabId}
              className="max-w-44 truncate px-2 py-1 text-xs aria-pressed:bg-muted"
              onClick={() => setSelectedId(tab.tabId)}
              title={tab.url}
            >
              {tab.title || tab.url || "New tab"}
              {tab.recording ? " • Recording" : ""}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title || "tab"}`}
              className="px-2 py-1"
              onClick={() =>
                void run({ action: "close", threadId: threadRef.threadId, tabId: tab.tabId })
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-sm"
          onClick={() => void run({ action: "open", threadId: threadRef.threadId })}
        >
          New tab
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-xs"
          onClick={() => void run({ action: "list", threadId: threadRef.threadId })}
        >
          Refresh tabs
        </button>
      </div>
      <form
        className="flex gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          let url = address;
          try {
            url = normalizePreviewUrl(address);
          } catch {
            // The environment reports malformed addresses through its own error.
          }
          if (!target) {
            openUrl(url);
            return;
          }
          void run({ action: "navigate", ...target, url }).then((navigated) => {
            if (navigated) recordVisitForThread(threadRef, url);
          });
        }}
      >
        {(["back", "forward", "reload"] as const).map((action) => (
          <button
            key={action}
            type="button"
            disabled={!target || busy}
            className="rounded border px-2 text-sm disabled:opacity-40"
            aria-label={action}
            onClick={() => target && void run({ action, ...target })}
          >
            {action === "back" ? "←" : action === "forward" ? "→" : "↻"}
          </button>
        ))}
        <input
          aria-label="Website address"
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="https://example.com"
        />
        <button className="rounded border px-2 text-sm" disabled={busy || !address.trim()}>
          Go
        </button>
      </form>
      {error && (
        <div role="alert" className="flex items-center gap-2 border-b p-2 text-sm text-destructive">
          <p className="min-w-0 flex-1">{error}</p>
          {canRequestTakeover ? (
            <button
              type="button"
              className="shrink-0 rounded border px-2 py-1 text-xs text-foreground"
              onClick={() => void takeControl()}
            >
              Take control
            </button>
          ) : null}
        </div>
      )}
      {target && (
        <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
          <button
            className="rounded border px-2 py-1"
            disabled={busy}
            onClick={() => void run({ action: "screenshot", ...target })}
          >
            Screenshot
          </button>
          <button
            className="rounded border px-2 py-1"
            disabled={busy}
            onClick={() =>
              void run({
                action: selected?.recording ? "recordingStop" : "recordingStart",
                ...target,
              })
            }
          >
            {selected?.recording ? "Stop recording" : "Record video"}
          </button>
          {state.artifacts?.map((artifact) =>
            baseUrl ? (
              <a
                key={artifact.id}
                className="underline"
                href={new URL(artifact.url, baseUrl).href}
                target="_blank"
                rel="noreferrer"
              >
                {artifact.mimeType.startsWith("video/") ? "Video" : "Screenshot"}{" "}
                {artifact.id.slice(-6)}
              </a>
            ) : null,
          )}
          {!state.artifacts?.length && artifactUrl && (
            <a className="underline" href={artifactUrl} target="_blank" rel="noreferrer">
              Open {state.artifact?.mimeType.startsWith("video/") ? "video" : "screenshot"}
            </a>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20">
        {!visible ? null : !hostReady ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Connecting to the remote browser…
          </p>
        ) : (
          <RemoteBrowserStream
            threadRef={threadRef}
            tabId={target?.tabId}
            onTabs={receiveTabs}
            onInput={run}
            emptyState={
              <div className="h-full w-full self-stretch">
                <PreviewEmptyState
                  environmentId={threadRef.environmentId}
                  configuredUrls={configuredUrls}
                  onOpenUrl={openUrl}
                />
              </div>
            }
          />
        )}
      </div>
      {target && (
        <form
          className="flex gap-2 border-t p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text) {
              const submittedText = text;
              void run({ action: "type", ...target, text }).then((sent) => {
                if (sent) setText((current) => (current === submittedText ? "" : current));
              });
            }
          }}
        >
          <input
            aria-label="Text to type in browser"
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type into the selected page field"
          />
          <button type="submit" disabled={!text || busy} className="rounded border px-2 text-sm">
            Type
          </button>
          <button
            type="button"
            className="rounded border px-2 text-sm"
            onClick={() => void run({ action: "press", ...target, key: "Enter" })}
          >
            Enter
          </button>
        </form>
      )}
    </section>
  );
}
