import {
  DownloadIcon,
  FolderOpenIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useDeferredValue, useState } from "react";

import { browserDownloadStatus, useBrowserDownloads } from "~/browser/useBrowserDownloads";
import { previewBridge } from "~/components/preview/previewBridge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";

import { SettingsPageContainer, SettingsSection } from "../settingsLayout";

const startedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : url);

export function BrowserDownloadsSettings() {
  const downloadsApi = previewBridge?.downloads ?? null;
  const downloads = useBrowserDownloads();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());

  const act = (label: string, action: () => Promise<void>) => {
    action().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: `Unable to ${label}`,
        description: error instanceof Error ? error.message : undefined,
      });
    });
  };

  const all = downloads ?? [];
  const entries =
    deferredQuery === ""
      ? all
      : all.filter(
          (download) =>
            download.filename.toLocaleLowerCase().includes(deferredQuery) ||
            download.url.toLocaleLowerCase().includes(deferredQuery),
        );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Download history"
        headerAction={
          downloadsApi && all.length > 0 ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => act("clear download history", () => downloadsApi.clear())}
            >
              Clear all
            </Button>
          ) : null
        }
      >
        <div className="space-y-3 px-3 @xl/settings:px-4">
          {!downloadsApi ? (
            <p className="text-sm text-muted-foreground">Update Pathway to see downloads.</p>
          ) : (
            <>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  className="ps-8"
                  placeholder="Search download history"
                  aria-label="Search download history"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {downloads === null ? null : entries.length === 0 ? (
                <Empty className="md:p-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <DownloadIcon />
                    </EmptyMedia>
                    {all.length === 0 ? (
                      <>
                        <EmptyTitle>No downloads yet</EmptyTitle>
                        <EmptyDescription>
                          Files downloaded from the built-in browser will appear here
                        </EmptyDescription>
                      </>
                    ) : (
                      <>
                        <EmptyTitle>No matching downloads</EmptyTitle>
                        <EmptyDescription>
                          Try searching for a different filename or address
                        </EmptyDescription>
                      </>
                    )}
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="divide-y divide-border/60 rounded-xl border">
                  {entries.map((download) => {
                    const openable = download.state === "completed" && download.exists;
                    const active = download.state === "progressing" || download.state === "paused";
                    return (
                      <li key={download.id} className="group flex items-center gap-3 px-3 py-2">
                        <DownloadIcon className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {openable ? (
                              <button
                                type="button"
                                className="truncate text-start text-sm hover:underline"
                                aria-label={`Open ${download.filename}`}
                                onClick={() =>
                                  act("open download", () => downloadsApi.open(download.id))
                                }
                              >
                                {download.filename}
                              </button>
                            ) : (
                              <span
                                className={`truncate text-sm ${
                                  download.state === "completed"
                                    ? "text-muted-foreground line-through"
                                    : ""
                                }`}
                              >
                                {download.filename}
                              </span>
                            )}
                            {download.state === "completed" && !download.exists ? (
                              <Badge variant="outline" size="sm">
                                Deleted
                              </Badge>
                            ) : null}
                            {download.initiator === "agent" ? (
                              <Badge variant="secondary" size="sm">
                                Agent
                              </Badge>
                            ) : null}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {hostOf(download.url)} · {browserDownloadStatus(download)} ·{" "}
                            {startedFormat.format(Date.parse(download.startedAt))}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-0.5">
                          {download.state === "progressing" ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Pause download"
                              title="Pause download"
                              onClick={() =>
                                act("pause download", () => downloadsApi.pause(download.id))
                              }
                            >
                              <PauseIcon />
                            </Button>
                          ) : null}
                          {download.state === "paused" ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Resume download"
                              title="Resume download"
                              onClick={() =>
                                act("resume download", () => downloadsApi.resume(download.id))
                              }
                            >
                              <PlayIcon />
                            </Button>
                          ) : null}
                          {active ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Cancel download"
                              title="Cancel download"
                              onClick={() =>
                                act("cancel download", () => downloadsApi.cancel(download.id))
                              }
                            >
                              <XIcon />
                            </Button>
                          ) : null}
                          {openable ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Show in folder"
                              title="Show in folder"
                              onClick={() =>
                                act("show download", () => downloadsApi.showInFolder(download.id))
                              }
                            >
                              <FolderOpenIcon />
                            </Button>
                          ) : null}
                          {active ? null : (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Remove from download history"
                              title="Remove from download history"
                              onClick={() =>
                                act("remove download", () => downloadsApi.remove(download.id))
                              }
                            >
                              <Trash2Icon />
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
