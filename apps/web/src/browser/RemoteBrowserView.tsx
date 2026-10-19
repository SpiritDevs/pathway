import { useAtomValue } from "@effect/atom-react";
import type {
  PreviewRemoteCommand,
  PreviewRemoteFrame as RemoteFrame,
  PreviewRemoteResult,
  PreviewRemoteTab,
  PreviewTabId,
  ScopedThreadRef,
} from "@spiritdevs/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useThreadProjection } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { BrowserSavedLoginPicker } from "./BrowserSavedLoginPicker";
import { remoteBrowserPoint } from "./remoteBrowserCoordinates";

export function RemoteBrowserView({
  threadRef,
  visible,
}: {
  threadRef: ScopedThreadRef;
  visible: boolean;
}) {
  const command = useAtomCommand(previewEnvironment.remoteCommand);
  const thread = useThreadProjection(threadRef)?.projection;
  const takeover = thread?.thread.browserTakeover;
  const requestTakeover = useAtomCommand(threadEnvironment.requestBrowserTakeover);
  const proceedTakeover = useAtomCommand(threadEnvironment.proceedBrowserTakeover);
  const releaseTakeover = useAtomCommand(threadEnvironment.releaseBrowserTakeover);
  const canRequestTakeover = thread?.runs.some((run) =>
    ["preparing", "starting", "running"].includes(run.status),
  );
  const [state, setState] = useState<PreviewRemoteResult>({ tabs: [], selectedTabId: null });
  const [selectedId, setSelectedId] = useState<PreviewTabId | null>(null);
  const [address, setAddress] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showLogins, setShowLogins] = useState(false);
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
    [command, threadRef.environmentId],
  );
  useEffect(() => {
    if (visible) void run({ action: "list", threadId: threadRef.threadId });
  }, [visible, run, threadRef.threadId]);
  useEffect(() => {
    setAddress(selected?.url ?? "");
  }, [selected?.tabId, selected?.url]);
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
  let selectedOrigin: string | null = null;
  try {
    if (selected?.url && /^https?:/.test(selected.url))
      selectedOrigin = new URL(selected.url).origin;
  } catch {
    /* A pending navigation has no usable origin yet. */
  }
  const reportTakeover = async (operation: Promise<{ _tag: string }>) => {
    const result = await operation;
    if (result._tag === "Failure")
      setError("Could not change browser control. Check the task status and try again.");
  };
  const artifactUrl = state.artifact && baseUrl ? new URL(state.artifact.url, baseUrl).href : null;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Environment browser">
      <div className="flex items-center gap-2 border-b px-2 py-1 text-xs">
        {takeover?.status === "active" ? (
          <>
            <span>You control the browser</span>
            <button
              className="rounded border px-2 py-1"
              onClick={() =>
                void reportTakeover(
                  proceedTakeover({
                    environmentId: threadRef.environmentId,
                    input: { threadId: threadRef.threadId, takeoverId: takeover.id },
                  }),
                )
              }
            >
              Resume agent
            </button>
            <button
              className="rounded border px-2 py-1"
              onClick={() =>
                void reportTakeover(
                  releaseTakeover({
                    environmentId: threadRef.environmentId,
                    input: { threadId: threadRef.threadId, takeoverId: takeover.id },
                  }),
                )
              }
            >
              End takeover
            </button>
          </>
        ) : takeover && ["requested", "pausing", "proceeding"].includes(takeover.status) ? (
          <span>{takeover.status === "proceeding" ? "Resuming agent…" : "Pausing agent…"}</span>
        ) : canRequestTakeover ? (
          <button
            className="rounded border px-2 py-1"
            onClick={() =>
              void reportTakeover(
                requestTakeover({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId },
                }),
              )
            }
          >
            Take control
          </button>
        ) : (
          <span>Browser runs on this environment</span>
        )}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto border-b p-1">
        {state.tabs.map((tab) => (
          <div key={tab.tabId} className="flex shrink-0 items-center rounded border">
            <button
              type="button"
              aria-pressed={selected?.tabId === tab.tabId}
              className="max-w-44 truncate px-2 py-1 text-xs aria-pressed:bg-muted"
              onClick={() => setSelectedId(tab.tabId)}
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
          void run(
            target
              ? { action: "navigate", ...target, url: address }
              : { action: "open", threadId: threadRef.threadId, url: address },
          );
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
        <p role="alert" className="border-b p-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {target && (
        <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
          {selectedOrigin && (
            <button
              className="rounded border px-2 py-1"
              onClick={() => setShowLogins((value) => !value)}
            >
              Saved logins
            </button>
          )}
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
          {showLogins && selectedOrigin && (
            <BrowserSavedLoginPicker
              key={`${target.tabId}:${selectedOrigin}`}
              threadRef={threadRef}
              tabId={target.tabId}
              origin={selectedOrigin}
            />
          )}
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
        {visible ? (
          <RemoteBrowserFrame
            key={target?.tabId ?? "metadata"}
            threadRef={threadRef}
            {...(target ? { tabId: target.tabId } : {})}
            run={run}
            onTabs={receiveTabs}
          />
        ) : null}
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

function RemoteBrowserFrame({
  threadRef,
  tabId,
  run,
  onTabs,
}: {
  threadRef: ScopedThreadRef;
  tabId?: PreviewTabId;
  run: (command: PreviewRemoteCommand) => Promise<boolean>;
  onTabs: (tabs: ReadonlyArray<PreviewRemoteTab>, metadataRevision?: number) => void;
}) {
  const result = useAtomValue(
    previewEnvironment.remoteFrames({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, ...(tabId ? { tabId } : {}) },
    }),
  );
  const [frame, setFrame] = useState<RemoteFrame>();
  const scroll = useRef({
    x: 0,
    y: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  useEffect(
    () => () => {
      clearTimeout(scroll.current.timer);
    },
    [],
  );
  const incoming = AsyncResult.isSuccess(result) ? result.value : undefined;
  useEffect(() => {
    if (incoming?.data) setFrame(incoming);
  }, [incoming]);
  const tabs = incoming?.tabs;
  const metadataRevision = incoming?.metadataRevision;
  useEffect(() => {
    if (tabs) onTabs(tabs, metadataRevision);
  }, [tabs, metadataRevision, onTabs]);
  if (!frame || !tabId || AsyncResult.isFailure(result))
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {AsyncResult.isFailure(result)
          ? "Browser connection interrupted. Reopen the tab to reconnect."
          : tabId
            ? "Connecting to the browser…"
            : "Open a tab to browse on this environment."}
      </p>
    );
  const target = { threadId: threadRef.threadId, tabId };
  return (
    <img
      alt="Remote browser page. Click to interact; use your keyboard after clicking."
      src={`data:${frame.mimeType};base64,${frame.data}`}
      className="h-full w-full object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      draggable={false}
      tabIndex={0}
      onClick={(event) => {
        event.currentTarget.focus();
        const box = event.currentTarget.getBoundingClientRect();
        const point = remoteBrowserPoint({
          x: event.clientX - box.left,
          y: event.clientY - box.top,
          boxWidth: box.width,
          boxHeight: box.height,
          width: frame.width,
          height: frame.height,
        });
        if (point) void run({ action: "click", ...target, ...point });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.blur();
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
        if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
        event.preventDefault();
        const modifiers = [
          event.metaKey ? "Meta" : "",
          event.ctrlKey ? "Control" : "",
          event.altKey ? "Alt" : "",
          event.shiftKey ? "Shift" : "",
        ].filter(Boolean);
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey)
          void run({ action: "type", ...target, text: event.key });
        else
          void run({
            action: "press",
            ...target,
            key: [...modifiers, event.key === " " ? "Space" : event.key].join("+"),
          });
      }}
      onPaste={(event) => {
        event.preventDefault();
        void run({ action: "type", ...target, text: event.clipboardData.getData("text/plain") });
      }}
      onWheel={(event) => {
        const pending = scroll.current;
        const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1;
        pending.x += event.deltaX * multiplier;
        pending.y += event.deltaY * multiplier;
        if (pending.timer !== undefined) return;
        pending.timer = setTimeout(() => {
          const deltaX = pending.x;
          const deltaY = pending.y;
          pending.x = 0;
          pending.y = 0;
          pending.timer = undefined;
          void run({ action: "scroll", ...target, deltaX, deltaY });
        }, 100);
      }}
    />
  );
}
