"use client";

import type { DesktopBrowserDownload } from "@spiritdevs/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  DownloadIcon,
  FileIcon,
  FolderOpenIcon,
  MoreHorizontal,
  PauseIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  type BrowserDownloadEntry,
  browserDownloadStatus,
  useBrowserDownloads,
} from "~/browser/useBrowserDownloads";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { previewBridge } from "./previewBridge";

/** The popover lists the latest few; the rest live in Settings → Browser → Downloads. */
const RECENT_DOWNLOAD_LIMIT = 8;

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function startedLabel(startedAt: string): string {
  const started = new Date(startedAt);
  return started.toDateString() === new Date().toDateString()
    ? timeFormat.format(started)
    : dateFormat.format(started);
}

function downloadDetail(download: BrowserDownloadEntry): string {
  // Running rows have a bar and speed to show; their start time is noise.
  if (download.state === "progressing" || download.state === "paused") {
    return browserDownloadStatus(download);
  }
  const missing = download.state === "completed" && !download.exists;
  return [
    missing ? "File moved or deleted" : null,
    browserDownloadStatus(download),
    startedLabel(download.startedAt),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function act(label: string, action: () => Promise<void>) {
  action().catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: `Unable to ${label}`,
      description: error instanceof Error ? error.message : undefined,
    });
  });
}

/** Combined progress of running downloads, 0–1, or `null` when no size is known. */
function runningProgress(running: ReadonlyArray<BrowserDownloadEntry>): number | null {
  const sized = running.filter((download) => download.totalBytes > 0);
  if (sized.length === 0) return null;
  const total = sized.reduce((sum, download) => sum + download.totalBytes, 0);
  const received = sized.reduce((sum, download) => sum + download.receivedBytes, 0);
  return Math.min(1, received / total);
}

const RING_RADIUS = 13;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Fills as running downloads progress; a plain ring when their size is unknown.
 * `m-0!` beats the button's icon margin, which would pull the ring off-center.
 */
function DownloadProgressRing(props: { progress: number | null; paused: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 30 30"
      className="pointer-events-none absolute inset-0 m-0! size-full -rotate-90"
    >
      <circle
        cx="15"
        cy="15"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        className={props.progress === null ? "stroke-primary/50" : "stroke-border"}
      />
      {props.progress === null ? null : (
        <circle
          cx="15"
          cy="15"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - props.progress)}
          className={cn(
            "transition-[stroke-dashoffset] duration-300",
            props.paused ? "stroke-muted-foreground" : "stroke-primary",
          )}
        />
      )}
    </svg>
  );
}

/**
 * Downloads button in the preview's page-tools pill, Chrome-style: it appears
 * once the built-in browser has downloaded something, nudges when a download
 * starts, and rings with progress while one runs.
 */
export function PreviewDownloadsMenu(props: { buttonClassName?: string }) {
  const navigate = useNavigate();
  const downloads = useBrowserDownloads();
  const downloadsApi = previewBridge?.downloads ?? null;
  // Bumped per event; the key remounts the animated element so the cue plays once.
  const [cue, setCue] = useState<{ kind: "start" | "done"; key: number } | null>(null);
  // A finished download keeps the icon highlighted until the list is opened.
  const [unseen, setUnseen] = useState(false);
  const seenStates = useRef<ReadonlyMap<string, DesktopBrowserDownload["state"]> | null>(null);
  useEffect(() => {
    if (!downloads) return;
    const previous = seenStates.current;
    seenStates.current = new Map(downloads.map((download) => [download.id, download.state]));
    // The first list is history, not news.
    if (previous === null) return;
    const started = downloads.some((download) => !previous.has(download.id));
    const finished = downloads.some((download) => {
      const before = previous.get(download.id);
      return download.state === "completed" && (before === "progressing" || before === "paused");
    });
    if (finished) {
      setUnseen(true);
      setCue((current) => ({ kind: "done", key: (current?.key ?? 0) + 1 }));
    } else if (started) setCue((current) => ({ kind: "start", key: (current?.key ?? 0) + 1 }));
  }, [downloads]);

  if (!downloadsApi || !downloads || downloads.length === 0) return null;

  const running = downloads.filter(
    (download) => download.state === "progressing" || download.state === "paused",
  );
  const recent = downloads.slice(0, RECENT_DOWNLOAD_LIMIT);
  const openFolder = downloadsApi.openFolder;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setUnseen(false);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn("relative", props.buttonClassName)}
                  type="button"
                  aria-label={running.length > 0 ? "Downloads, in progress" : "Downloads"}
                />
              }
            />
          }
        >
          <span
            key={cue?.kind === "start" ? cue.key : undefined}
            className={cn("flex", cue?.kind === "start" && "browser-download-start")}
          >
            <DownloadIcon className={cn((unseen || running.length > 0) && "text-primary")} />
          </span>
          {cue?.kind === "done" ? (
            <span
              key={cue.key}
              aria-hidden
              className="browser-download-done pointer-events-none absolute inset-0.5 rounded-full border-2 border-primary"
            />
          ) : null}
          {running.length > 0 ? (
            <DownloadProgressRing
              progress={runningProgress(running)}
              paused={running.every((download) => download.state === "paused")}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup>Downloads</TooltipPopup>
      </Tooltip>
      {/* Opaque, not glass: it opens over arbitrary page content, which would tint it. */}
      <PopoverPopup
        align="end"
        sideOffset={6}
        className="w-88 bg-popover"
        viewportClassName="py-2 [--viewport-inline-padding:--spacing(2)]"
      >
        <div className="flex h-8 items-center justify-between ps-2">
          <h3 className="text-sm font-medium">Downloads</h3>
          {openFolder ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open downloads folder"
              title="Open downloads folder"
              onClick={() => act("open the downloads folder", openFolder)}
            >
              <FolderOpenIcon />
            </Button>
          ) : null}
        </div>
        <ul className="mt-1 space-y-0.5">
          {recent.map((download) => {
            const openable = download.state === "completed" && download.exists;
            const downloading = download.state === "progressing" || download.state === "paused";
            const fraction =
              downloading && download.totalBytes > 0
                ? Math.min(1, download.receivedBytes / download.totalBytes)
                : null;
            return (
              <li key={download.id} className="group flex items-center gap-1 rounded-md">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1.5 text-start enabled:hover:bg-accent disabled:cursor-default"
                  disabled={!openable}
                  aria-label={openable ? `Open ${download.filename}` : download.filename}
                  onClick={() => act("open download", () => downloadsApi.open(download.id))}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <FileIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm",
                        !openable && !downloading && "text-muted-foreground",
                      )}
                    >
                      {download.filename}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground tabular-nums">
                      {downloadDetail(download)}
                    </span>
                    {fraction !== null ? (
                      <span
                        role="progressbar"
                        aria-label={`${download.filename} progress`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(fraction * 100)}
                        className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted"
                      >
                        <span
                          className={cn(
                            "block h-full rounded-full transition-[width] duration-300",
                            download.state === "paused" ? "bg-muted-foreground" : "bg-primary",
                          )}
                          style={{ width: `${fraction * 100}%` }}
                        />
                      </span>
                    ) : null}
                  </span>
                </button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="shrink-0"
                  aria-label={`Show ${download.filename} in folder`}
                  title="Show in folder"
                  disabled={!openable}
                  onClick={() => act("show download", () => downloadsApi.showInFolder(download.id))}
                >
                  <FolderOpenIcon />
                </Button>
                {downloading ? (
                  <>
                    {download.state === "paused" ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0"
                        aria-label={`Resume ${download.filename}`}
                        title="Resume"
                        onClick={() =>
                          act("resume download", () => downloadsApi.resume(download.id))
                        }
                      >
                        <PlayIcon />
                      </Button>
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0"
                        aria-label={`Pause ${download.filename}`}
                        title="Pause"
                        onClick={() => act("pause download", () => downloadsApi.pause(download.id))}
                      >
                        <PauseIcon />
                      </Button>
                    )}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="shrink-0"
                      aria-label={`Cancel ${download.filename}`}
                      title="Cancel"
                      onClick={() => act("cancel download", () => downloadsApi.cancel(download.id))}
                    >
                      <XIcon />
                    </Button>
                  </>
                ) : (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="shrink-0"
                          aria-label={`More actions for ${download.filename}`}
                        />
                      }
                    >
                      <MoreHorizontal />
                    </MenuTrigger>
                    <MenuPopup align="end" className="min-w-40 bg-popover">
                      {openable ? (
                        <MenuItem
                          onClick={() => act("open download", () => downloadsApi.open(download.id))}
                        >
                          Open
                        </MenuItem>
                      ) : null}
                      {openable ? <MenuSeparator /> : null}
                      <MenuItem
                        onClick={() =>
                          act("remove download", () => downloadsApi.remove(download.id))
                        }
                      >
                        Remove from list
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                )}
              </li>
            );
          })}
        </ul>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start text-muted-foreground"
          onClick={() => void navigate({ to: "/settings/browser/downloads" })}
        >
          {downloads.length > recent.length
            ? `Show all downloads (${downloads.length})`
            : "Show all downloads"}
        </Button>
      </PopoverPopup>
    </Popover>
  );
}
