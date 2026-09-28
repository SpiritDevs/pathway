import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PreviewRemoteDownload,
  PreviewRemoteInteractionCommand,
  PreviewRemoteInteractionState,
  PreviewTabId,
  ScopedThreadRef,
} from "@spiritdevs/contracts";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { uploadStandaloneFileAttachment } from "~/lib/attachmentUploadQueue";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { cdpModifiers, wheelPixels } from "./remoteBrowserSurface";

type Interaction = PreviewRemoteInteractionCommand extends infer C
  ? C extends unknown
    ? Omit<C, "threadId" | "tabId">
    : never
  : never;

/**
 * Everything an interactive viewer adds on top of pixels: the page's cursor,
 * precise pointer and wheel input, copy back to this device, and the page's
 * dialogs, select menus, file choosers and downloads. Subscribing is what asks
 * the environment to present prompts here instead of auto-dismissing them.
 */
export function RemoteBrowserInteractions({
  threadRef,
  tabId,
  canvasRef,
  pagePoint,
  pageHeight,
}: {
  threadRef: ScopedThreadRef;
  tabId: PreviewTabId;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  pagePoint: (event: { clientX: number; clientY: number }) => { x: number; y: number } | null;
  pageHeight: () => number;
}) {
  const atom = useMemo(
    () =>
      previewEnvironment.remoteInteractions({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      }),
    [threadRef.environmentId, threadRef.threadId],
  );
  const result = useAtomValue(atom);
  const tab = AsyncResult.isSuccess(result)
    ? result.value.tabs.find((candidate) => candidate.tabId === tabId)
    : undefined;
  const command = useAtomCommand(previewEnvironment.remoteInteract);
  const [error, setError] = useState<string>();
  const interact = async (input: Interaction) => {
    const outcome = await command({
      environmentId: threadRef.environmentId,
      input: { ...input, threadId: threadRef.threadId, tabId } as PreviewRemoteInteractionCommand,
    });
    if (outcome._tag === "Failure") {
      const failure = squashAtomCommandFailure(outcome);
      setError(failure instanceof Error ? failure.message : "The browser did not respond.");
      return null;
    }
    setError(undefined);
    return outcome.value;
  };
  const interactRef = useRef(interact);
  interactRef.current = interact;
  const pagePointRef = useRef(pagePoint);
  pagePointRef.current = pagePoint;
  const pageHeightRef = useRef(pageHeight);
  pageHeightRef.current = pageHeight;

  const cursor = tab?.cursor ?? "default";
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = cursor;
  }, [canvasRef, cursor]);

  // Pointer and wheel input coalesce to one message per animation frame, and
  // only while the pointer moves; nothing runs while the page sits still.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    let move: { x: number; y: number } | null = null;
    let wheel: { x: number; y: number; deltaX: number; deltaY: number; modifiers: number } | null =
      null;
    const flush = () => {
      frame = 0;
      if (wheel) void interactRef.current({ action: "wheel", ...wheel });
      else if (move) void interactRef.current({ action: "pointerMove", ...move });
      wheel = null;
      move = null;
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(flush);
    };
    const onMove = (event: PointerEvent) => {
      const point = pagePointRef.current(event);
      if (!point) return;
      move = point;
      schedule();
    };
    const onWheel = (event: WheelEvent) => {
      const point = pagePointRef.current(event);
      if (!point) return;
      const delta = wheelPixels(event, pageHeightRef.current());
      wheel = {
        ...point,
        deltaX: (wheel?.deltaX ?? 0) + delta.deltaX,
        deltaY: (wheel?.deltaY ?? 0) + delta.deltaY,
        modifiers: cdpModifiers(event),
      };
      schedule();
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvasRef]);

  // Text copied or cut in the page lands on this device while the page has focus.
  const clipboard = tab?.clipboard ?? null;
  const seenClipboard = useRef(clipboard);
  useEffect(() => {
    if (clipboard === seenClipboard.current) return;
    seenClipboard.current = clipboard;
    if (clipboard === null || document.activeElement !== canvasRef.current) return;
    void navigator.clipboard?.writeText(clipboard).catch(() => {
      /* Clipboard access can be denied; the page copy still happened remotely. */
    });
  }, [canvasRef, clipboard]);

  return (
    <>
      {tab ? (
        <RemoteBrowserPrompt
          key={promptKey(tab)}
          environmentId={threadRef.environmentId}
          tab={tab}
          interact={interact}
        />
      ) : null}
      {tab?.downloads.length ? (
        <RemoteBrowserDownloads environmentId={threadRef.environmentId} downloads={tab.downloads} />
      ) : null}
      {error ? (
        <p
          role="alert"
          className="absolute top-2 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded border bg-background/95 px-2 py-1 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}

function promptKey(tab: PreviewRemoteInteractionState) {
  return tab.dialog?.dialogId ?? tab.select?.selectId ?? tab.fileChooser?.chooserId ?? "none";
}

type Interact = (input: Interaction) => Promise<PreviewRemoteInteractionState | null>;

function PromptCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/40 p-4">
      <div
        role="dialog"
        aria-label={title}
        className="flex max-h-full w-full max-w-sm flex-col gap-3 overflow-hidden rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
      >
        {children}
      </div>
    </div>
  );
}

/** The page's pending prompt, if any. Keyed by prompt id so its local state resets. */
function RemoteBrowserPrompt({
  environmentId,
  tab,
  interact,
}: {
  environmentId: EnvironmentId;
  tab: PreviewRemoteInteractionState;
  interact: Interact;
}) {
  if (tab.dialog) return <DialogPrompt dialog={tab.dialog} interact={interact} />;
  if (tab.select) return <SelectPrompt select={tab.select} interact={interact} />;
  if (tab.fileChooser)
    return (
      <FileChooserPrompt
        environmentId={environmentId}
        chooser={tab.fileChooser}
        interact={interact}
      />
    );
  return null;
}

function DialogPrompt({
  dialog,
  interact,
}: {
  dialog: NonNullable<PreviewRemoteInteractionState["dialog"]>;
  interact: Interact;
}) {
  const [text, setText] = useState(dialog.defaultValue);
  const [busy, setBusy] = useState(false);
  const respond = async (accept: boolean) => {
    setBusy(true);
    await interact({
      action: "dialogRespond",
      dialogId: dialog.dialogId,
      accept,
      ...(dialog.kind === "prompt" && accept ? { promptText: text } : {}),
    });
    setBusy(false);
  };
  const leaving = dialog.kind === "beforeunload";
  return (
    <PromptCard title={leaving ? "Leave page?" : "The page says"}>
      <p className="font-medium">{leaving ? "Leave this page?" : "The page says"}</p>
      <p className="overflow-y-auto break-words whitespace-pre-wrap text-muted-foreground">
        {dialog.message || (leaving ? "Changes you made may not be saved." : "")}
      </p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void respond(true);
        }}
      >
        {dialog.kind === "prompt" ? (
          <input
            aria-label="Response"
            autoFocus
            className="rounded border bg-background px-2 py-1"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          {dialog.kind !== "alert" ? (
            <button
              type="button"
              disabled={busy}
              className="rounded border px-3 py-1"
              onClick={() => void respond(false)}
            >
              {leaving ? "Stay" : "Cancel"}
            </button>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            autoFocus={dialog.kind !== "prompt"}
            className="rounded bg-primary px-3 py-1 text-primary-foreground"
          >
            {leaving ? "Leave" : "OK"}
          </button>
        </div>
      </form>
    </PromptCard>
  );
}

function SelectPrompt({
  select,
  interact,
}: {
  select: NonNullable<PreviewRemoteInteractionState["select"]>;
  interact: Interact;
}) {
  const [chosen, setChosen] = useState(
    () => new Set(select.options.filter((option) => option.selected).map((option) => option.index)),
  );
  const choose = (indices: number[] | null) =>
    void interact({ action: "selectChoose", selectId: select.selectId, indices });
  return (
    <PromptCard title="Choose an option">
      <ul className="-mx-1 flex flex-col overflow-y-auto">
        {select.options.map((option) => (
          <li key={option.index}>
            {select.multiple ? (
              <label className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted aria-disabled:opacity-50">
                <input
                  type="checkbox"
                  disabled={option.disabled}
                  checked={chosen.has(option.index)}
                  onChange={(event) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(option.index);
                      else next.delete(option.index);
                      return next;
                    })
                  }
                />
                <span className="truncate">{option.label || option.value}</span>
              </label>
            ) : (
              <button
                type="button"
                disabled={option.disabled}
                aria-pressed={option.selected}
                className="w-full truncate rounded px-2 py-1 text-left hover:bg-muted disabled:opacity-50 aria-pressed:font-medium"
                onClick={() => choose([option.index])}
              >
                {option.label || option.value}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded border px-3 py-1" onClick={() => choose(null)}>
          Cancel
        </button>
        {select.multiple ? (
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-primary-foreground"
            onClick={() => choose([...chosen])}
          >
            Done
          </button>
        ) : null}
      </div>
    </PromptCard>
  );
}

function FileChooserPrompt({
  environmentId,
  chooser,
  interact,
}: {
  environmentId: EnvironmentId;
  chooser: NonNullable<PreviewRemoteInteractionState["fileChooser"]>;
  interact: Interact;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setStatus(`Uploading ${files.length === 1 ? files[0]!.name : `${files.length} files`}…`);
    try {
      const uploaded = await Promise.all(
        files.map((file) =>
          uploadStandaloneFileAttachment({
            environmentId,
            file,
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          }),
        ),
      );
      setStatus("Sending to the page…");
      await interact({
        action: "fileChooserRespond",
        chooserId: chooser.chooserId,
        files: uploaded.map((file) => ({
          attachmentId: file.id,
          name: file.name,
          mimeType: file.mimeType,
        })),
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.");
      setBusy(false);
    }
  };
  return (
    <PromptCard title="Choose files">
      <p className="font-medium">The page wants {chooser.multiple ? "files" : "a file"}</p>
      <p className="text-muted-foreground">
        Files you pick are uploaded to the environment running this browser.
      </p>
      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
      <input
        ref={input}
        type="file"
        hidden
        multiple={chooser.multiple}
        onChange={(event) => void upload([...(event.target.files ?? [])])}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          className="rounded border px-3 py-1"
          onClick={() =>
            void interact({ action: "fileChooserRespond", chooserId: chooser.chooserId, files: [] })
          }
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          autoFocus
          className="rounded bg-primary px-3 py-1 text-primary-foreground"
          onClick={() => input.current?.click()}
        >
          Choose {chooser.multiple ? "files" : "file"}…
        </button>
      </div>
    </PromptCard>
  );
}

function RemoteBrowserDownloads({
  environmentId,
  downloads,
}: {
  environmentId: EnvironmentId;
  downloads: ReadonlyArray<PreviewRemoteDownload>;
}) {
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [open, setOpen] = useState(false);
  const active = downloads.filter((download) => download.status === "downloading").length;
  return (
    <div className="absolute bottom-2 left-2 flex max-w-[60%] flex-col items-start gap-1">
      {open ? (
        <ul className="flex max-h-48 w-64 max-w-full flex-col overflow-y-auto rounded-lg border bg-popover p-1 text-xs shadow-lg">
          {downloads.map((download) => (
            <li key={download.downloadId} className="flex items-center gap-2 rounded px-2 py-1">
              <span className="min-w-0 flex-1 truncate" title={download.name}>
                {download.name}
              </span>
              {download.status === "ready" && download.url && baseUrl ? (
                <a
                  className="shrink-0 underline"
                  href={new URL(download.url, baseUrl).href}
                  download={download.name}
                  target="_blank"
                  rel="noreferrer"
                >
                  Save
                </a>
              ) : (
                <span
                  className={`shrink-0 ${download.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                  title={download.error}
                >
                  {download.status === "failed" ? "Failed" : "Downloading…"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        className="rounded-full border bg-background/85 px-2 py-0.5 text-[11px] text-muted-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        {active ? `Downloading ${active}…` : `Downloads (${downloads.length})`}
      </button>
    </div>
  );
}
