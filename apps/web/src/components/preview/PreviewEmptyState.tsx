import type { EnvironmentId } from "@spiritdevs/contracts";
import { ChevronDown, Globe } from "lucide-react";
import type { ReactNode } from "react";

import { useBrowserHistoryStore, useBrowserWideHistory } from "~/browserHistoryStore";
import { useBrowserPinnedSites, useBrowserPinnedSitesStore } from "~/browserPinnedSitesStore";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Kbd } from "~/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "~/components/ui/menu";

import { useNewTabTools, type PanelSurfaceAction } from "./newTabTools";
import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewSiteTile } from "./PreviewSiteTile";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

const RECENT_SITE_LIMIT = 8;

interface Props {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentlySeenUrls?: ReadonlyArray<string> | undefined;
  onOpenUrl: (url: string) => void;
}

/**
 * The new-tab page: the panel's other tools, pinned and recently visited pages
 * from history across every project, then servers.
 */
export function PreviewEmptyState({
  environmentId,
  configuredUrls,
  recentlySeenUrls,
  onOpenUrl,
}: Props) {
  const tools = useNewTabTools();
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
    recentlySeenUrls,
  });
  const history = useBrowserWideHistory();
  const pinned = useBrowserPinnedSites();
  const { pin, unpin } = useBrowserPinnedSitesStore.getState();
  const { removeEverywhere } = useBrowserHistoryStore.getState();
  const pinnedUrls = new Set(pinned.map((site) => site.url));
  const recent = history
    .filter((entry) => URL.canParse(entry.url) && !pinnedUrls.has(entry.url))
    .slice(0, RECENT_SITE_LIMIT);
  const titleOf = (url: string, fallback?: string) =>
    history.find((entry) => entry.url === url)?.title ?? fallback;

  if (tools.length === 0 && servers.length === 0 && pinned.length === 0 && recent.length === 0) {
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
            <div className="grid grid-cols-2 gap-2">
              {tools.map((tool) => (
                <ToolTile key={tool.kind} tool={tool} />
              ))}
            </div>
          </NewTabSection>
        ) : null}
        {pinned.length > 0 ? (
          <NewTabSection title="Pinned">
            <div className={SITE_GRID_CLASS_NAME}>
              {pinned
                .filter((site) => URL.canParse(site.url))
                .map((site) => (
                  <PreviewSiteTile
                    key={site.url}
                    url={site.url}
                    title={titleOf(site.url, site.title)}
                    pinned
                    onOpen={() => onOpenUrl(site.url)}
                    onTogglePin={() => unpin(site.url)}
                  />
                ))}
            </div>
          </NewTabSection>
        ) : null}
        {recent.length > 0 ? (
          <NewTabSection title="Recently visited">
            <div className={SITE_GRID_CLASS_NAME}>
              {recent.map((entry) => (
                <PreviewSiteTile
                  key={entry.url}
                  url={entry.url}
                  title={entry.title}
                  pinned={false}
                  onOpen={() => onOpenUrl(entry.url)}
                  onTogglePin={() =>
                    pin({ url: entry.url, ...(entry.title ? { title: entry.title } : {}) })
                  }
                  onRemove={() => removeEverywhere([entry.url])}
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

const SITE_GRID_CLASS_NAME = "grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1";

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
    <div className="flex h-11 min-w-0 items-center rounded-lg border border-border/70 bg-card text-sm">
      <button
        type="button"
        onClick={tool.onClick}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left hover:bg-accent/60"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{tool.label}</span>
        {tool.badgeCount > 0 ? (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-[10px] font-semibold tabular-nums text-white">
            {tool.badgeCount}
          </span>
        ) : null}
        {tool.shortcut ? <Kbd className="shrink-0">{tool.shortcut}</Kbd> : null}
      </button>
      {tool.alternatives && tool.alternatives.length > 0 ? (
        <Menu>
          <MenuTrigger
            aria-label={`More ways to open ${tool.label}`}
            className="mr-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <ChevronDown className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {tool.alternatives.map((alternative) => (
              <MenuItem key={alternative.label} onClick={alternative.onClick}>
                {alternative.label}
                {alternative.shortcut ? <MenuShortcut>{alternative.shortcut}</MenuShortcut> : null}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
