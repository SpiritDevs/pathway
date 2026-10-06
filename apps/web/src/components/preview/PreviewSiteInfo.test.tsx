import type { DesktopPreviewBridge, DesktopPreviewSiteInfo } from "@spiritdevs/contracts";
import type { ReactNode } from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
  type ReactTestRendererNode,
} from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Popover } from "~/components/ui/popover";

import {
  SiteMainView,
  SiteSecurityView,
  previewSiteActions,
  siteConnection,
} from "./PreviewSiteInfo";

const runtimeInfo: DesktopPreviewSiteInfo = {
  runtime: true,
  origin: "https://www.google.com",
  securityState: "secure",
  connection: { protocol: "TLS 1.3", summary: "TLS 1.3, X25519 and AES_128_GCM" },
  certificate: {
    isValid: true,
    chain: [
      {
        subject: { commonName: "*.google.com", organizations: [], organizationUnits: [] },
        issuer: {
          commonName: "WR2",
          organizations: ["Google Trust Services"],
          organizationUnits: [],
        },
        serialNumber: "5A:3B:9C",
        validStart: 1_788_000_000,
        validExpiry: 1_795_000_000,
        fingerprintSha256: "ab".repeat(32),
        publicKeySha256: "cd".repeat(32),
        subjectAlternativeNames: ["*.google.com"],
        signatureAlgorithm: "SHA256-RSA",
        publicKeyAlgorithm: "ECDSA P-256",
      },
    ],
  },
};

const secure = siteConnection(new URL("https://www.google.com/"), "secure");

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

/** Renders a view inside the dropdown, which owns its title and close button. */
async function renderView(view: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<Popover>{view}</Popover>);
  });
  const textOf = (node: ReactTestRendererNode | ReactTestRendererNode[] | null): string =>
    node === null
      ? ""
      : typeof node === "string"
        ? node
        : Array.isArray(node)
          ? node.map(textOf).join("")
          : textOf(node.children ?? null);
  return {
    text: textOf(renderer!.toJSON()),
    labelled: (label: string) =>
      renderer!.root.findAll(
        (node) => node.type === "button" && node.props["aria-label"] === label,
      ),
    row: (label: string): ReactTestInstance =>
      renderer!.root.find((node) => node.type === "span" && node.props.children === label).parent!,
  };
}

describe("siteConnection", () => {
  it("follows Chromium's security state", () => {
    expect(siteConnection(new URL("https://www.google.com/"), "secure").title).toBe(
      "Connection is secure",
    );
    expect(siteConnection(new URL("http://example.com/"), "insecure").title).toBe(
      "Connection is not secure",
    );
    expect(siteConnection(new URL("https://example.com/"), "dangerous").title).toBe(
      "Dangerous site",
    );
    expect(siteConnection(new URL("https://example.com/"), "unknown").title).toBe(
      "Connection not checked",
    );
  });

  it("calls plain http on this computer a local server, but not a failing https one", () => {
    expect(siteConnection(new URL("http://localhost:3000/"), "insecure").title).toBe(
      "Local server",
    );
    expect(siteConnection(new URL("https://localhost:3000/"), "insecure").title).toBe(
      "Connection is not secure",
    );
  });
});

describe("previewSiteActions", () => {
  it("opens Site settings, loads and clears through the tab's bridge methods", async () => {
    const bridge = {
      siteInfo: vi.fn(async () => runtimeInfo),
      openSiteSettings: vi.fn(async () => {}),
      clearSiteData: vi.fn(async () => {}),
    };
    const actions = previewSiteActions(bridge as unknown as DesktopPreviewBridge, "tab-7");

    actions.openSiteSettings?.();
    actions.clearSiteData?.();

    expect(await actions.load?.()).toBe(runtimeInfo);
    expect(bridge.siteInfo).toHaveBeenCalledWith("tab-7");
    expect(bridge.openSiteSettings).toHaveBeenCalledWith("tab-7");
    expect(bridge.clearSiteData).toHaveBeenCalledWith("tab-7");
  });

  it("offers nothing a desktop build without the methods cannot do", () => {
    expect(previewSiteActions({} as DesktopPreviewBridge, "tab-7")).toEqual({
      load: undefined,
      openSiteSettings: undefined,
      clearSiteData: undefined,
    });
  });
});

describe("SiteMainView", () => {
  it("shows the site, its connection and Site settings on the runtime", async () => {
    const view = await renderView(
      <SiteMainView
        site="google.com"
        connection={secure}
        pending={false}
        onShowSecurity={vi.fn()}
        onOpenSiteSettings={vi.fn()}
        onClearSiteData={vi.fn()}
      />,
    );

    expect(view.text).toContain("google.com");
    expect(view.labelled("Close")).toHaveLength(1);
    expect(view.text).toContain("Connection is secure");
    expect(view.text).toContain("Clear site data");
    expect(view.text).toContain("Site settings");
  });

  it("has no Site settings on stock Electron, and no guessed connection while loading", async () => {
    const view = await renderView(
      <SiteMainView site="google.com" connection={secure} pending onShowSecurity={vi.fn()} />,
    );

    expect(view.text).toContain("google.com");
    expect(view.text).not.toContain("Site settings");
    expect(view.text).not.toContain("Connection is secure");
  });

  it("opens the Security view and Site settings from their rows", async () => {
    const showSecurity = vi.fn();
    const openSiteSettings = vi.fn();
    const view = await renderView(
      <SiteMainView
        site="google.com"
        connection={secure}
        pending={false}
        onShowSecurity={showSecurity}
        onOpenSiteSettings={openSiteSettings}
      />,
    );

    await act(async () => view.row("Connection is secure").props.onClick());
    await act(async () => view.row("Site settings").props.onClick());

    expect(showSecurity).toHaveBeenCalledOnce();
    expect(openSiteSettings).toHaveBeenCalledOnce();
  });
});

describe("SiteSecurityView", () => {
  it("explains the connection and opens the certificate on the runtime", async () => {
    const back = vi.fn();
    const showCertificate = vi.fn();
    const view = await renderView(
      <SiteSecurityView
        site="google.com"
        connection={secure}
        details={runtimeInfo.connection}
        certificate={runtimeInfo.certificate}
        onBack={back}
        onShowCertificate={showCertificate}
      />,
    );

    expect(view.text).toContain("Security");
    expect(view.text).toContain("google.com");
    expect(view.text).toContain("Connection is secure");
    expect(view.text).toContain("is private when it is sent to this site");
    expect(view.text).toContain("TLS 1.3, X25519 and AES_128_GCM");
    expect(view.text).toContain("Issued to *.google.com");

    await act(async () => view.labelled("Back")[0]!.props.onClick());
    await act(async () => view.row("Certificate is valid").parent!.props.onClick());

    expect(back).toHaveBeenCalledOnce();
    expect(showCertificate).toHaveBeenCalledOnce();
  });

  it("shows a certificate error and an invalid certificate as such", async () => {
    const view = await renderView(
      <SiteSecurityView
        site="expired.badssl.com"
        connection={siteConnection(new URL("https://expired.badssl.com/"), "insecure")}
        details={{ summary: "", certificateError: "NET::ERR_CERT_DATE_INVALID" }}
        certificate={{ ...runtimeInfo.certificate!, isValid: false }}
        onBack={vi.fn()}
        onShowCertificate={vi.fn()}
      />,
    );

    expect(view.text).toContain("Connection is not secure");
    expect(view.text).toContain("NET::ERR_CERT_DATE_INVALID");
    expect(view.text).toContain("Certificate is not valid");
  });

  it("invents no certificate on stock Electron", async () => {
    const view = await renderView(
      <SiteSecurityView
        site="google.com"
        connection={secure}
        details={null}
        certificate={null}
        onBack={vi.fn()}
        onShowCertificate={vi.fn()}
      />,
    );

    expect(view.text).toContain("Connection is secure");
    expect(view.text).not.toContain("Certificate");
  });
});
