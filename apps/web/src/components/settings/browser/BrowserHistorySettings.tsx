import { ExternalLinkIcon, HistoryIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

import { openBrowserDialog } from "~/browser/browserDialogs";
import { listBrowserHistory, useBrowserHistoryStore } from "~/browserHistoryStore";
import { PreviewFavicon } from "~/components/preview/PreviewFavicon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { readLocalApi } from "~/localApi";

import { SettingsPageContainer, SettingsSection } from "../settingsLayout";

type VisitSource = "all" | "agent" | "other";

/** Rows rendered at once; the rest load on demand so long histories stay cheap. */
const PAGE_SIZE = 200;

const visitTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const EMPTY_STATES: Readonly<Record<VisitSource, { title: string; description: string }>> = {
  all: {
    title: "No browsing history yet",
    description: "Pages visited in the built-in browser will appear here",
  },
  agent: {
    title: "No agent visits",
    description: "Choose a different visit source to see more history",
  },
  other: {
    title: "No other visits",
    description: "Choose a different visit source to see more history",
  },
};

export function BrowserHistorySettings() {
  const byProjectKey = useBrowserHistoryStore((state) => state.byProjectKey);
  const removeEverywhere = useBrowserHistoryStore((state) => state.removeEverywhere);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [source, setSource] = useState<VisitSource>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);

  const all = useMemo(() => listBrowserHistory(byProjectKey), [byProjectKey]);
  const entries = useMemo(
    () =>
      all.filter(
        (entry) =>
          (source === "all" || (source === "agent") === (entry.source === "agent")) &&
          (deferredQuery === "" ||
            entry.url.toLocaleLowerCase().includes(deferredQuery) ||
            (entry.title?.toLocaleLowerCase().includes(deferredQuery) ?? false)),
      ),
    [all, source, deferredQuery],
  );
  const visible = entries.slice(0, limit);
  const selectedVisible = entries.filter((entry) => selected.has(entry.url));

  const toggle = (url: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(url);
      else next.delete(url);
      return next;
    });

  const remove = (urls: ReadonlyArray<string>) => {
    removeEverywhere(urls);
    setSelected((current) => new Set([...current].filter((url) => !urls.includes(url))));
  };

  const empty =
    all.length === 0
      ? EMPTY_STATES.all
      : deferredQuery !== ""
        ? {
            title: "No matching pages",
            description: "Try searching for a different page or address",
          }
        : EMPTY_STATES[source];

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Browsing history"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => openBrowserDialog("clear-data")}>
            Clear browsing data
          </Button>
        }
      >
        <div className="space-y-3 px-3 @xl/settings:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                className="ps-8"
                placeholder="Search browsing history"
                aria-label="Search browsing history"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PAGE_SIZE);
                }}
              />
            </div>
            <ToggleGroup
              value={[source]}
              onValueChange={(value) => {
                const next = value[0] as VisitSource | undefined;
                if (next) setSource(next);
                setLimit(PAGE_SIZE);
              }}
              variant="outline"
              size="sm"
              aria-label="Visit source"
            >
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="agent">Agent</ToggleGroupItem>
              <ToggleGroupItem value="other">Other</ToggleGroupItem>
            </ToggleGroup>
            {selectedVisible.length > 0 ? (
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => remove(selectedVisible.map((entry) => entry.url))}
              >
                Remove selected ({selectedVisible.length})
              </Button>
            ) : null}
          </div>

          {entries.length === 0 ? (
            <Empty className="md:p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HistoryIcon />
                </EmptyMedia>
                <EmptyTitle>{empty.title}</EmptyTitle>
                <EmptyDescription>{empty.description}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y divide-border/60 rounded-xl border">
              {visible.map((entry) => (
                <li key={entry.url} className="group flex items-center gap-3 px-3 py-2">
                  <Checkbox
                    checked={selected.has(entry.url)}
                    aria-label={`Select ${entry.title ?? entry.url}`}
                    onCheckedChange={(checked) => toggle(entry.url, checked === true)}
                  />
                  <PreviewFavicon url={entry.url} className="size-4" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm">{entry.title || entry.url}</span>
                      {entry.source === "agent" ? (
                        <Badge variant="secondary" size="sm">
                          Agent
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{entry.url}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {visitTimeFormat.format(entry.lastVisitedAt)}
                  </span>
                  <div className="flex shrink-0 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Open page"
                      title="Open page"
                      onClick={() => void readLocalApi()?.shell.openExternal(entry.url)}
                    >
                      <ExternalLinkIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Remove from history"
                      title="Remove from history"
                      onClick={() => remove([entry.url])}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {entries.length > visible.length ? (
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
            >
              Show more
            </Button>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
