import { EnvironmentId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

type HistoryEntry = { url: string; lastVisitedAt: number; title?: string; visits?: number };

const mocks = vi.hoisted(() => ({
  history: [] as Array<{ url: string; lastVisitedAt: number; title?: string }>,
  pinned: [] as Array<{ url: string; title?: string }>,
  servers: [] as Array<{
    host: string;
    port: number;
    url: string;
    requestedUrl: string;
    processName: string | null;
    pid: number | null;
    terminal: null;
    source: "scanner";
    listening: boolean;
  }>,
}));

vi.mock("~/browserHistoryStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browserHistoryStore")>()),
  useBrowserWideHistory: () => mocks.history,
}));

vi.mock("~/browserPinnedSitesStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browserPinnedSitesStore")>()),
  useBrowserPinnedSites: () => mocks.pinned,
}));

vi.mock("./useDiscoveredLocalServers", () => ({
  useDiscoveredLocalServers: () => mocks.servers,
}));

import { PreviewEmptyState } from "./PreviewEmptyState";

const environmentId = EnvironmentId.make("env-1");

function server(port: number) {
  return {
    host: "localhost",
    port,
    url: `http://localhost:${port}`,
    requestedUrl: `http://localhost:${port}`,
    processName: "node",
    pid: 1,
    terminal: null,
    source: "scanner" as const,
    listening: true,
  };
}

/** History arrives newest first, as the browser-wide hook returns it. */
function render(
  recentEntries: Array<HistoryEntry>,
  pinned: Array<{ url: string; title?: string }> = [],
) {
  mocks.history = recentEntries.toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt);
  mocks.pinned = pinned;
  return renderToStaticMarkup(
    <PreviewEmptyState environmentId={environmentId} onOpenUrl={() => undefined} />,
  );
}

describe("PreviewEmptyState", () => {
  it("renders a history entry in both groups when its host:port matches a live server", () => {
    mocks.servers = [server(5173)];
    const html = render([
      { url: "https://myapp.test/admin#users", lastVisitedAt: Date.now(), title: "Admin" },
      { url: "http://localhost:5173/", lastVisitedAt: Date.now(), title: "Recent Local" },
    ]);
    expect(html).toContain("Recently visited");
    expect(html).toContain(">Servers<");
    expect(html.indexOf("Recently visited")).toBeLessThan(html.indexOf(">Servers<"));
    expect(html).toContain("myapp.test/admin#users");
    expect(html).toContain("Admin");
    expect(html).toContain("Recent Local");
    expect(html).toContain("node");
  });

  it("renders only the recently visited group when no servers are found", () => {
    mocks.servers = [];
    const html = render([{ url: "https://myapp.test/", lastVisitedAt: 0 }]);
    expect(html).toContain("Recently visited");
    expect(html).not.toContain(">Servers<");
  });

  it("orders recently visited pages newest first", () => {
    mocks.servers = [];
    const html = render([
      { url: "https://recent.test/", lastVisitedAt: 2, title: "Recent" },
      { url: "https://often.test/", lastVisitedAt: 1, title: "Often", visits: 5 },
    ]);
    expect(html.indexOf("Recent")).toBeLessThan(html.indexOf("Often"));
  });

  it("shows pinned pages first and leaves them out of recently visited", () => {
    mocks.servers = [];
    const html = render(
      [
        { url: "https://pinned.test/", lastVisitedAt: 2, title: "Pinned page" },
        { url: "https://other.test/", lastVisitedAt: 1, title: "Other page" },
      ],
      [{ url: "https://pinned.test/" }],
    );
    expect(html.indexOf(">Pinned<")).toBeLessThan(html.indexOf("Recently visited"));
    expect(html.lastIndexOf("Pinned page")).toBeLessThan(html.indexOf("Recently visited"));
    expect(html.indexOf("Other page")).toBeGreaterThan(html.indexOf("Recently visited"));
  });

  it("keeps the original empty state when both groups are empty", () => {
    mocks.servers = [];
    const html = render([]);
    expect(html).toContain("No preview yet");
  });

  it("renders an out-of-range lastVisitedAt entry without throwing", () => {
    mocks.servers = [];
    let html = "";
    expect(() => {
      html = render([{ url: "https://myapp.test/", lastVisitedAt: 1e20 }]);
    }).not.toThrow();
    expect(html).toContain("myapp.test");
    expect(html).toContain("More actions for myapp.test");
  });
});
