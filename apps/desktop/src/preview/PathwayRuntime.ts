/**
 * The local browser's site information, from the Pathway Chromium runtime
 * (ADR 0049) when the app runs on it. The runtime adds a `pathway` module to
 * `require("electron")`; stock Electron has none, so there the browser only
 * knows what the page's URL says and keeps its Electron-session fallbacks.
 */
import type { DesktopPreviewSiteInfo } from "@spiritdevs/contracts";
import * as Electron from "electron";

export interface PathwayCertificateName {
  commonName?: string;
  organizations: string[];
  organizationUnits: string[];
  country?: string;
  locality?: string;
  state?: string;
}

export interface PathwayCertificate {
  pem: string;
  subject: PathwayCertificateName;
  issuer: PathwayCertificateName;
  serialNumber: string;
  validStart: number;
  validExpiry: number;
  fingerprintSha256: string;
  publicKeySha256: string;
  subjectAlternativeNames: string[];
  signatureAlgorithm: string;
  publicKeyAlgorithm: string;
}

export interface PathwaySiteInfo {
  origin: string;
  securityState: "secure" | "neutral" | "insecure" | "dangerous" | "unknown";
  connection: {
    protocol?: string;
    keyExchange?: string;
    cipher?: string;
    certificateError?: string;
    summary: string;
  };
  certificate: { chain: PathwayCertificate[]; isValid: boolean; verifiedAt?: number } | null;
  storage: { cookieCount: number; usageBytes: number };
}

/** The parts of the runtime's `pathway` module the browser uses. */
export interface PathwayModule {
  siteInfo(webContents: Electron.WebContents): Promise<PathwaySiteInfo>;
  clearSiteData(partition: string, origin: string): Promise<void>;
  /** `chrome://settings/content/siteDetails?site=<encoded origin>` */
  settingsUrl(origin: string): string;
}

/** The runtime's module, or undefined on stock Electron. */
export const pathwayModule = (): PathwayModule | undefined =>
  "pathway" in Electron ? (Electron.pathway as PathwayModule) : undefined;

/** The origin of a website. Blank, file and `chrome://` pages have no site information. */
export const webOrigin = (url: string): string | null =>
  /^https?:/i.test(url) && URL.canParse(url) ? new URL(url).origin : null;

/**
 * The site in a tab. Stock Electron only knows the scheme, and an https page
 * that loaded there already passed Chromium's certificate checks.
 */
export const siteInfo = async (
  webContents: Electron.WebContents,
  pathway = pathwayModule(),
): Promise<DesktopPreviewSiteInfo | null> => {
  const origin = webOrigin(webContents.getURL());
  if (origin === null) return null;
  if (!pathway) {
    return {
      runtime: false,
      origin,
      securityState: origin.startsWith("https:") ? "secure" : "insecure",
      connection: null,
      certificate: null,
    };
  }
  const info = await pathway.siteInfo(webContents);
  return {
    runtime: true,
    origin: info.origin,
    securityState: info.securityState,
    connection: info.connection,
    // The renderer shows parsed fields only, so PEMs stay in the main process.
    certificate: info.certificate && {
      isValid: info.certificate.isValid,
      chain: info.certificate.chain.map(({ pem: _pem, ...certificate }) => certificate),
    },
  };
};

/** Chrome's settings page for the tab's site, which only exists on the runtime. */
export const siteSettingsUrl = (
  webContents: Electron.WebContents,
  pathway = pathwayModule(),
): string => {
  if (!pathway) throw new Error("Site settings need the Pathway browser runtime.");
  const origin = webOrigin(webContents.getURL());
  if (origin === null) throw new Error("Site settings are only available for websites.");
  return pathway.settingsUrl(origin);
};

/**
 * Clears the tab's site data, then reloads it. The runtime clears through
 * Chrome's browsing-data remover for the tab's partition; stock Electron
 * clears the origin's storage in the tab's session.
 */
export const clearSiteData = async (
  webContents: Electron.WebContents,
  partition: string | undefined,
  pathway = pathwayModule(),
): Promise<void> => {
  const origin = webOrigin(webContents.getURL());
  if (origin === null) return;
  if (pathway && partition !== undefined) {
    await pathway.clearSiteData(partition, origin);
  } else {
    await webContents.session.clearStorageData({
      origin,
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
  }
  if (!webContents.isDestroyed()) webContents.reload();
};
