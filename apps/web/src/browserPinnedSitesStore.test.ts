import { beforeEach, describe, expect, it } from "vite-plus/test";

import { migratePersistedPinnedSites, useBrowserPinnedSitesStore } from "./browserPinnedSitesStore";

describe("browserPinnedSitesStore", () => {
  beforeEach(() => useBrowserPinnedSitesStore.setState({ sites: [] }));

  it("pins once per address and unpins", () => {
    const { pin, unpin } = useBrowserPinnedSitesStore.getState();
    pin({ url: "https://example.com", title: "Example" });
    pin({ url: "https://example.com/" });
    expect(useBrowserPinnedSitesStore.getState().sites).toEqual([
      { url: "https://example.com/", title: "Example" },
    ]);
    unpin("https://example.com");
    expect(useBrowserPinnedSitesStore.getState().sites).toEqual([]);
  });

  it("drops invalid and duplicate saved pins", () => {
    expect(
      migratePersistedPinnedSites({
        sites: [
          { url: "https://a.test" },
          { url: "https://a.test/" },
          { url: 42 },
          null,
          { url: "https://b.test", title: "" },
        ],
      }),
    ).toEqual({ sites: [{ url: "https://a.test/" }, { url: "https://b.test/" }] });
    expect(migratePersistedPinnedSites(undefined)).toEqual({ sites: [] });
  });
});
