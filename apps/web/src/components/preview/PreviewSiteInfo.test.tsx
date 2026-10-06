import type { DesktopPreviewBridge, DesktopPreviewSiteInfo } from "@spiritdevs/contracts";
import type { ReactElement, ReactNode } from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
  type ReactTestRendererNode,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Popover } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";

import {
  PreviewSiteInfo,
  type PreviewSiteActions,
  SiteMainView,
  SiteSecurityView,
  previewSiteActions,
  siteConnection,
} from "./PreviewSiteInfo";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

// The real popup renders into a portal, which the test renderer cannot follow.
// These stand-ins keep the dropdown's own open state and render it inline.
vi.mock("~/components/ui/popover", async () => {
  const React = await import("react");
  const PopoverState = React.createContext({
    open: false,
    onOpenChange: (_open: boolean) => {},
  });
  const withRender = (
    render: ReactElement<Record<string, unknown>> | undefined,
    props: Record<string, unknown>,
    children: ReactNode,
  ) =>
    render
      ? React.cloneElement(render, props, children)
      : React.createElement("button", { type: "button", ...props }, children);
  return {
    Popover: (props: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      children?: ReactNode;
    }) =>
      React.createElement(
        PopoverState.Provider,
        { value: { open: props.open ?? false, onOpenChange: props.onOpenChange ?? (() => {}) } },
        props.children,
      ),
    PopoverTrigger: (props: {
      render?: ReactElement<Record<string, unknown>>;
      children?: ReactNode;
    }) => {
      const { onOpenChange } = React.useContext(PopoverState);
      return withRender(props.render, { onClick: () => onOpenChange(true) }, props.children);
    },
    PopoverClose: (props: {
      render?: ReactElement<Record<string, unknown>>;
      children?: ReactNode;
    }) => {
      const { onOpenChange } = React.useContext(PopoverState);
      return withRender(props.render, { onClick: () => onOpenChange(false) }, props.children);
    },
    PopoverPopup: (props: { children?: ReactNode }) =>
      React.useContext(PopoverState).open
        ? React.createElement("div", { role: "dialog" }, props.children)
        : null,
    PopoverTitle: (props: { children?: ReactNode }) =>
      React.createElement("h2", null, props.children),
  };
});

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
        validStart: Date.UTC(2026, 8, 22),
        validExpiry: Date.UTC(2026, 11, 15),
        fingerprintSha256: Array(32).fill("AB").join(":"),
        publicKeySha256: Array(32).fill("CD").join(":"),
        subjectAlternativeNames: ["*.google.com"],
        signatureAlgorithm: "SHA256-RSA",
        publicKeyAlgorithm: "ECDSA P-256",
      },
    ],
  },
};

/** What stock Electron reports: the origin and its scheme, nothing more. */
const stockInfo: DesktopPreviewSiteInfo = {
  runtime: false,
  origin: "https://www.google.com",
  securityState: "secure",
  connection: null,
  certificate: null,
};

const secure = siteConnection(new URL("https://www.google.com/"), "secure");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.mocked(toastManager.add).mockClear();
});

const textOf = (node: ReactTestRendererNode | ReactTestRendererNode[] | null): string =>
  node === null
    ? ""
    : typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(textOf).join("")
        : textOf(node.children ?? null);

const text = () => textOf(renderer!.toJSON());
const labelled = (label: string) =>
  renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === label);
const row = (label: string): ReactTestInstance =>
  renderer!.root.find((node) => node.type === "span" && node.props.children === label).parent!;

/** Renders a view inside the dropdown, which owns its title and close button. */
async function renderView(view: ReactNode) {
  await act(async () => {
    renderer = create(<Popover>{view}</Popover>);
  });
  return { text: text(), labelled, row };
}

/** Renders the site button, then opens its dropdown. */
async function openSiteInfo(url: string, actions: PreviewSiteActions) {
  await act(async () => {
    renderer = create(<PreviewSiteInfo url={url} actions={actions} />);
  });
  expect(text()).toBe("");
  await act(async () => labelled("Site information")[0]!.props.onClick());
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
  it("loads and clears through the tab's bridge methods", async () => {
    const bridge = {
      siteInfo: vi.fn(async () => runtimeInfo),
      clearSiteData: vi.fn(async () => {}),
    };
    const actions = previewSiteActions(
      bridge as unknown as DesktopPreviewBridge,
      "tab-7",
      vi.fn(async () => null),
    );

    actions.clearSiteData?.();

    expect(await actions.load?.()).toBe(runtimeInfo);
    expect(bridge.siteInfo).toHaveBeenCalledWith("tab-7");
    expect(bridge.clearSiteData).toHaveBeenCalledWith("tab-7");
  });

  it("opens a blank tab, then has the main process load Site settings into it", async () => {
    const calls: string[] = [];
    const openTab = vi.fn(async () => {
      calls.push("openTab");
      return "tab-8";
    });
    const bridge = {
      openSiteSettings: vi.fn(async (tabId: string, targetTabId: string) => {
        calls.push(`openSiteSettings ${tabId} ${targetTabId}`);
      }),
    };

    await act(async () => {
      previewSiteActions(
        bridge as unknown as DesktopPreviewBridge,
        "tab-7",
        openTab,
      ).openSiteSettings?.();
    });

    expect(calls).toEqual(["openTab", "openSiteSettings tab-7 tab-8"]);
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("says so when Site settings cannot open, and opens nothing without a tab", async () => {
    const openSiteSettings = vi.fn(async () => {
      throw new Error("Site settings need the Pathway browser runtime.");
    });
    const bridge = { openSiteSettings } as unknown as DesktopPreviewBridge;

    await act(async () => {
      previewSiteActions(bridge, "tab-7", async () => null).openSiteSettings?.();
    });
    expect(openSiteSettings).not.toHaveBeenCalled();

    await act(async () => {
      previewSiteActions(bridge, "tab-7", async () => "tab-8").openSiteSettings?.();
    });
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Site settings could not open" }),
    );
  });

  it("offers nothing a desktop build without the methods cannot do", () => {
    expect(previewSiteActions({} as DesktopPreviewBridge, "tab-7", async () => null)).toEqual({
      load: undefined,
      openSiteSettings: undefined,
      clearSiteData: undefined,
    });
  });
});

describe("PreviewSiteInfo", () => {
  it("loads the site when opened and offers Site settings only on the runtime", async () => {
    const load = vi.fn(async () => runtimeInfo);
    const openSiteSettings = vi.fn();
    await openSiteInfo("https://www.google.com/search?q=1", {
      load,
      openSiteSettings,
      clearSiteData: vi.fn(),
    });

    expect(load).toHaveBeenCalledOnce();
    expect(text()).toContain("google.com");
    expect(text()).toContain("Connection is secure");
    expect(text()).toContain("Clear site data");
    expect(text()).toContain("Site settings");

    await act(async () => row("Site settings").props.onClick());

    expect(openSiteSettings).toHaveBeenCalledOnce();
    expect(text()).toBe("");
  });

  it("has no Site settings on stock Electron", async () => {
    await openSiteInfo("https://www.google.com/", {
      load: async () => stockInfo,
      openSiteSettings: vi.fn(),
      clearSiteData: vi.fn(),
    });

    expect(text()).toContain("Connection is secure");
    expect(text()).toContain("Clear site data");
    expect(text()).not.toContain("Site settings");
  });

  it("shows no connection until the site's information arrives", async () => {
    const answer = deferred<DesktopPreviewSiteInfo | null>();
    await openSiteInfo("https://www.google.com/", { load: () => answer.promise });

    expect(text()).toContain("google.com");
    expect(text()).not.toContain("Connection");

    await act(async () => answer.resolve(runtimeInfo));

    expect(text()).toContain("Connection is secure");
  });

  it("does not claim a secure connection when the desktop cannot say", async () => {
    await openSiteInfo("https://www.google.com/", {
      load: async () => {
        throw new Error("siteInfo failed");
      },
      openSiteSettings: vi.fn(),
    });

    expect(text()).toContain("Connection not checked");
    expect(text()).not.toContain("Connection is secure");
    expect(text()).not.toContain("Site settings");
  });

  it("keeps the latest site's answer when an earlier one arrives late", async () => {
    const answers = [
      deferred<DesktopPreviewSiteInfo | null>(),
      deferred<DesktopPreviewSiteInfo | null>(),
    ];
    let requests = 0;
    const load = vi.fn(() => answers[requests++]!.promise);
    await openSiteInfo("https://old.example/", { load });

    // A page in the same site does not ask again.
    await act(async () =>
      renderer!.update(<PreviewSiteInfo url="https://old.example/#top" actions={{ load }} />),
    );
    expect(load).toHaveBeenCalledOnce();

    await act(async () =>
      renderer!.update(<PreviewSiteInfo url="https://www.google.com/" actions={{ load }} />),
    );
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => answers[1]!.resolve(runtimeInfo));
    await act(async () => answers[0]!.resolve({ ...runtimeInfo, securityState: "dangerous" }));

    expect(text()).toContain("google.com");
    expect(text()).toContain("Connection is secure");
    expect(text()).not.toContain("Dangerous site");
  });

  it("is not offered for pages that are not websites", async () => {
    await act(async () => {
      renderer = create(
        <PreviewSiteInfo
          url="chrome://settings/content/siteDetails?site=https%3A%2F%2Fwww.google.com"
          actions={{ load: vi.fn() }}
        />,
      );
    });

    expect(renderer!.toJSON()).toBeNull();
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
