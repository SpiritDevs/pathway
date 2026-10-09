import type { DesktopBrowserDownload } from "@spiritdevs/contracts";
import { useEffect, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { formatStorageBytes } from "~/lib/storagePresentation";

/** A download plus its current speed, `null` until two progress updates have arrived. */
export type BrowserDownloadEntry = DesktopBrowserDownload & {
  readonly bytesPerSecond: number | null;
};

export interface DownloadSample {
  readonly receivedBytes: number;
  readonly at: number;
  readonly bytesPerSecond: number | null;
}

/** Weight of the newest reading, so the speed settles instead of jittering per update. */
const RATE_SMOOTHING = 0.3;

/**
 * Derives each running download's speed from the previous list's samples.
 * Returns the entries and the samples to pass in with the next list.
 */
export function withDownloadRates(
  downloads: ReadonlyArray<DesktopBrowserDownload>,
  samples: ReadonlyMap<string, DownloadSample>,
  now: number,
): {
  readonly entries: ReadonlyArray<BrowserDownloadEntry>;
  readonly samples: ReadonlyMap<string, DownloadSample>;
} {
  const next = new Map<string, DownloadSample>();
  const entries = downloads.map((download) => {
    if (download.state !== "progressing") return { ...download, bytesPerSecond: null };
    const previous = samples.get(download.id);
    let bytesPerSecond = previous?.bytesPerSecond ?? null;
    let sample: DownloadSample = { receivedBytes: download.receivedBytes, at: now, bytesPerSecond };
    if (previous && download.receivedBytes > previous.receivedBytes && now > previous.at) {
      const reading =
        ((download.receivedBytes - previous.receivedBytes) * 1000) / (now - previous.at);
      bytesPerSecond =
        bytesPerSecond === null
          ? reading
          : bytesPerSecond + RATE_SMOOTHING * (reading - bytesPerSecond);
      sample = { ...sample, bytesPerSecond };
    } else if (previous) {
      // No new bytes yet: measure the next reading from the last real progress.
      sample = previous;
    }
    next.set(download.id, sample);
    return { ...download, bytesPerSecond };
  });
  return { entries, samples: next };
}

/**
 * The built-in browser's download list, kept current by the desktop.
 * `null` until the first list arrives or when there is no desktop bridge.
 */
export function useBrowserDownloads(): ReadonlyArray<BrowserDownloadEntry> | null {
  const downloadsApi = previewBridge?.downloads ?? null;
  const [downloads, setDownloads] = useState<ReadonlyArray<BrowserDownloadEntry> | null>(null);

  useEffect(() => {
    if (!downloadsApi) return;
    let cancelled = false;
    let samples: ReadonlyMap<string, DownloadSample> = new Map();
    const receive = (list: ReadonlyArray<DesktopBrowserDownload>) => {
      const next = withDownloadRates(list, samples, performance.now());
      samples = next.samples;
      setDownloads(next.entries);
    };
    void downloadsApi
      .list()
      .then((next) => {
        if (!cancelled) receive(next);
      })
      .catch(() => {
        if (!cancelled) setDownloads([]);
      });
    const unsubscribe = downloadsApi.onChange(receive);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [downloadsApi]);

  return downloads;
}

/**
 * Progress or outcome for one download, e.g. `4.2 MB/s · 2 MB of 10 MB`,
 * `Paused · 2 MB of 10 MB`, or `Failed`.
 */
export function browserDownloadStatus(download: BrowserDownloadEntry): string {
  switch (download.state) {
    case "progressing":
    case "paused": {
      const received = formatStorageBytes(download.receivedBytes);
      const total = download.totalBytes > 0 ? ` of ${formatStorageBytes(download.totalBytes)}` : "";
      const prefix =
        download.state === "paused"
          ? "Paused · "
          : download.bytesPerSecond !== null
            ? `${formatStorageBytes(download.bytesPerSecond)}/s · `
            : "";
      return `${prefix}${received}${total}`;
    }
    case "completed":
      return formatStorageBytes(download.totalBytes || download.receivedBytes);
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Failed";
    case "blocked":
      return "Blocked by agent permissions";
  }
}
