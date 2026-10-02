import { EnvironmentId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
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

function render(
  recentEntries: Array<{ url: string; lastVisitedAt: number; title?: string; visits?: number }>,
) {
  return renderToStaticMarkup(
    <PreviewEmptyState
      environmentId={environmentId}
      recentEntries={recentEntries}
      onRemoveRecent={() => undefined}
      onOpenUrl={() => undefined}
    />,
  );
}

describe("PreviewEmptyState", () => {
  it("renders a history entry in both groups when its host:port matches a live server", () => {
    mocks.servers = [server(5173)];
    const html = render([
      { url: "https://myapp.test/admin#users", lastVisitedAt: Date.now(), title: "Admin" },
      { url: "http://localhost:5173/", lastVisitedAt: Date.now(), title: "Recent Local" },
    ]);
    expect(html).toContain("Frequently visited");
    expect(html).toContain(">Servers<");
    expect(html).toContain("myapp.test/admin#users");
    expect(html).toContain("Admin");
    expect(html).toContain("Recent Local");
    expect(html).toContain("node");
  });

  it("renders only the frequently visited group when no servers are found", () => {
    mocks.servers = [];
    const html = render([{ url: "https://myapp.test/", lastVisitedAt: 0 }]);
    expect(html).toContain("Frequently visited");
    expect(html).not.toContain(">Servers<");
  });

  it("orders frequently visited pages by visit count", () => {
    mocks.servers = [];
    const html = render([
      { url: "https://recent.test/", lastVisitedAt: 2, title: "Recent" },
      { url: "https://often.test/", lastVisitedAt: 1, title: "Often", visits: 5 },
    ]);
    expect(html.indexOf("Often")).toBeLessThan(html.indexOf("Recent"));
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
    expect(html).toContain("Remove");
  });
});
