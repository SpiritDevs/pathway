import type { EnvironmentId } from "@spiritdevs/contracts";
import { Globe } from "lucide-react";
import type { ReactNode } from "react";

import { historyEntryVisits, type BrowserHistoryEntry } from "~/browserHistoryStore";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";

import { useNewTabTools, type PanelSurfaceAction } from "./newTabTools";
import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewSiteTile } from "./PreviewSiteTile";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

const FREQUENT_SITE_LIMIT = 8;

interface Props {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentlySeenUrls?: ReadonlyArray<string> | undefined;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

/** The new-tab page: the panel's other tools, frequently visited pages, then servers. */
export function PreviewEmptyState({
  environmentId,
  configuredUrls,
  recentlySeenUrls,
  recentEntries,
  onRemoveRecent,
  onOpenUrl,
}: Props) {
  const tools = useNewTabTools();
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
    recentlySeenUrls,
  });
  const frequent = recentEntries
    .filter((entry) => URL.canParse(entry.url))
    .toSorted(
      (a, b) => historyEntryVisits(b) - historyEntryVisits(a) || b.lastVisitedAt - a.lastVisitedAt,
    )
    .slice(0, FREQUENT_SITE_LIMIT);

  if (tools.length === 0 && servers.length === 0 && frequent.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Globe className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No preview yet</EmptyTitle>
        <EmptyDescription>
          Type a URL above, or run a dev script. Listening localhost ports will show up here
          automatically.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
        {tools.length > 0 ? (
          <NewTabSection title="Tools">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
              {tools.map((tool) => (
                <ToolTile key={tool.kind} tool={tool} />
              ))}
            </div>
          </NewTabSection>
        ) : null}
        {frequent.length > 0 ? (
          <NewTabSection title="Frequently visited">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1">
              {frequent.map((entry) => (
                <PreviewSiteTile
                  key={entry.url}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </div>
          </NewTabSection>
        ) : null}
        {servers.length > 0 ? (
          <NewTabSection title="Servers">
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {servers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
          </NewTabSection>
        ) : (
          <p className="text-xs text-muted-foreground">
            Type a URL above, or run a dev script. Listening ports will show up here automatically.
          </p>
        )}
      </div>
    </div>
  );
}

function NewTabSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function ToolTile({ tool }: { tool: PanelSurfaceAction }) {
  const Icon = tool.icon;
  return (
    <button
      type="button"
      onClick={tool.onClick}
      className="flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border/70 bg-card px-3 text-left text-sm hover:bg-accent/60"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{tool.label}</span>
      {tool.badgeCount > 0 ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-[10px] font-semibold tabular-nums text-white">
          {tool.badgeCount}
        </span>
      ) : null}
    </button>
  );
}
