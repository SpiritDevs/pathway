import type { DesktopBrowserDownload } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { browserDownloadStatus, withDownloadRates } from "./useBrowserDownloads";

const download = (patch: Partial<DesktopBrowserDownload>): DesktopBrowserDownload => ({
  id: "a",
  url: "https://example.com/file.dmg",
  filename: "file.dmg",
  path: "/tmp/file.dmg",
  mimeType: "application/octet-stream",
  totalBytes: 10_000_000,
  receivedBytes: 0,
  state: "progressing",
  startedAt: "2026-10-09T00:00:00.000Z",
  endedAt: null,
  exists: false,
  initiator: "user",
  ...patch,
});

describe("withDownloadRates", () => {
  it("measures speed between progress updates and smooths later readings", () => {
    const first = withDownloadRates([download({ receivedBytes: 0 })], new Map(), 0);
    expect(first.entries[0]?.bytesPerSecond).toBeNull();

    const second = withDownloadRates([download({ receivedBytes: 1_000_000 })], first.samples, 1000);
    expect(second.entries[0]?.bytesPerSecond).toBe(1_000_000);
    expect(browserDownloadStatus(second.entries[0]!)).toBe("1 MB/s · 1 MB of 10 MB");

    const third = withDownloadRates([download({ receivedBytes: 3_000_000 })], second.samples, 2000);
    expect(third.entries[0]?.bytesPerSecond).toBe(1_300_000);
  });

  it("keeps the last speed through an update with no new bytes", () => {
    const first = withDownloadRates([download({ receivedBytes: 0 })], new Map(), 0);
    const second = withDownloadRates([download({ receivedBytes: 500_000 })], first.samples, 500);
    const stalled = withDownloadRates([download({ receivedBytes: 500_000 })], second.samples, 750);
    expect(stalled.entries[0]?.bytesPerSecond).toBe(1_000_000);
  });

  it("drops speed once a download is paused or finished", () => {
    const first = withDownloadRates([download({ receivedBytes: 0 })], new Map(), 0);
    const second = withDownloadRates([download({ receivedBytes: 500_000 })], first.samples, 500);
    const paused = withDownloadRates(
      [download({ receivedBytes: 500_000, state: "paused" })],
      second.samples,
      750,
    );
    expect(paused.entries[0]?.bytesPerSecond).toBeNull();
    expect(browserDownloadStatus(paused.entries[0]!)).toBe("Paused · 500 kB of 10 MB");
  });
});
