import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PathwayCertificate, PathwaySiteInfo } from "./PathwayRuntime.ts";

const leaf: PathwayCertificate = {
  pem: "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----",
  subject: { commonName: "*.google.com", organizations: [], organizationUnits: [] },
  issuer: {
    commonName: "WR2",
    organizations: ["Google Trust Services"],
    organizationUnits: [],
    country: "US",
  },
  serialNumber: "0A1B2C",
  validStart: 1_788_000_000,
  validExpiry: 1_795_000_000,
  fingerprintSha256: "aa".repeat(32),
  publicKeySha256: "bb".repeat(32),
  subjectAlternativeNames: ["*.google.com", "google.com"],
  signatureAlgorithm: "SHA256-RSA",
  publicKeyAlgorithm: "ECDSA P-256",
};

const runtimeInfo: PathwaySiteInfo = {
  origin: "https://www.google.com",
  securityState: "secure",
  connection: {
    protocol: "TLS 1.3",
    keyExchange: "X25519",
    cipher: "AES_128_GCM",
    summary: "TLS 1.3, X25519 and AES_128_GCM",
  },
  certificate: { chain: [leaf], isValid: true, verifiedAt: 1_790_000_000_000 },
  storage: { cookieCount: 3, usageBytes: 2048 },
};

const pathway = {
  siteInfo: vi.fn(async (_webContents: unknown) => runtimeInfo),
  clearSiteData: vi.fn(async (_partition: string, _origin: string) => {}),
  settingsUrl: vi.fn(
    (origin: string) => `chrome://settings/content/siteDetails?site=${encodeURIComponent(origin)}`,
  ),
};

/** Loads the adapter against a mocked `electron`, with or without the runtime's module. */
async function loadAdapter(electron: object) {
  vi.resetModules();
  vi.doMock("electron", () => electron);
  return import("./PathwayRuntime.ts");
}

function makeWebContents(url: string) {
  return {
    getURL: () => url,
    isDestroyed: () => false,
    reload: vi.fn(),
    session: { clearStorageData: vi.fn(async (_options: unknown) => {}) },
  };
}

type TestWebContents = ReturnType<typeof makeWebContents>;
const asWebContents = (webContents: TestWebContents) =>
  webContents as unknown as Electron.WebContents;

beforeEach(() => {
  pathway.siteInfo.mockClear();
  pathway.clearSiteData.mockClear();
  pathway.settingsUrl.mockClear();
});

describe("on stock Electron", () => {
  it("reports only the origin and whether its scheme is secure", async () => {
    const adapter = await loadAdapter({});
    expect(adapter.pathwayModule()).toBeUndefined();

    expect(
      await adapter.siteInfo(asWebContents(makeWebContents("https://www.google.com/search?q=1"))),
    ).toEqual({
      runtime: false,
      origin: "https://www.google.com",
      securityState: "secure",
      connection: null,
      certificate: null,
    });
    expect(
      await adapter.siteInfo(asWebContents(makeWebContents("http://localhost:3000/app"))),
    ).toMatchObject({ runtime: false, securityState: "insecure", certificate: null });
    expect(await adapter.siteInfo(asWebContents(makeWebContents("about:blank")))).toBeNull();
  });

  it("does not offer Site settings", async () => {
    const adapter = await loadAdapter({});
    expect(() =>
      adapter.siteSettingsUrl(asWebContents(makeWebContents("https://example.com/"))),
    ).toThrow("Pathway browser runtime");
  });

  it("clears the origin's storage in the tab's session, then reloads", async () => {
    const adapter = await loadAdapter({});
    const webContents = makeWebContents("https://example.com/account");

    await adapter.clearSiteData(asWebContents(webContents), "persist:pathway-preview-test");

    expect(webContents.session.clearStorageData).toHaveBeenCalledWith({
      origin: "https://example.com",
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    expect(webContents.reload).toHaveBeenCalledOnce();
  });

  it("leaves pages that are not websites alone", async () => {
    const adapter = await loadAdapter({});
    const webContents = makeWebContents("chrome://settings/");

    await adapter.clearSiteData(asWebContents(webContents), undefined);

    expect(webContents.session.clearStorageData).not.toHaveBeenCalled();
    expect(webContents.reload).not.toHaveBeenCalled();
  });
});

describe("on the Pathway runtime", () => {
  it("detects electron.pathway", async () => {
    const adapter = await loadAdapter({ pathway });
    expect(adapter.pathwayModule()).toBe(pathway);
  });

  it("passes Chromium's site information through, without PEMs or storage", async () => {
    const adapter = await loadAdapter({ pathway });
    const webContents = asWebContents(makeWebContents("https://www.google.com/"));

    const info = await adapter.siteInfo(webContents);

    expect(pathway.siteInfo).toHaveBeenCalledWith(webContents);
    const { pem: _pem, ...leafFields } = leaf;
    expect(info).toEqual({
      runtime: true,
      origin: "https://www.google.com",
      securityState: "secure",
      connection: runtimeInfo.connection,
      certificate: { isValid: true, chain: [leafFields] },
    });
  });

  it("does not ask the runtime about pages that are not websites", async () => {
    const adapter = await loadAdapter({ pathway });
    expect(await adapter.siteInfo(asWebContents(makeWebContents("chrome://settings/")))).toBeNull();
    expect(pathway.siteInfo).not.toHaveBeenCalled();
  });

  it("builds the Site settings address for the tab's origin", async () => {
    const adapter = await loadAdapter({ pathway });
    expect(
      adapter.siteSettingsUrl(asWebContents(makeWebContents("https://www.google.com/maps"))),
    ).toBe("chrome://settings/content/siteDetails?site=https%3A%2F%2Fwww.google.com");
    expect(pathway.settingsUrl).toHaveBeenCalledWith("https://www.google.com");
  });

  it("clears site data through the runtime for the tab's partition", async () => {
    const adapter = await loadAdapter({ pathway });
    const webContents = makeWebContents("https://example.com/account");

    await adapter.clearSiteData(asWebContents(webContents), "persist:pathway-preview-test");

    expect(pathway.clearSiteData).toHaveBeenCalledWith(
      "persist:pathway-preview-test",
      "https://example.com",
    );
    expect(webContents.session.clearStorageData).not.toHaveBeenCalled();
    expect(webContents.reload).toHaveBeenCalledOnce();
  });
});
