import { EnvironmentId } from "@spiritdevs/contracts";
import type { XcodeStatus } from "@spiritdevs/contracts/xcode";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AppleIdSessionView } from "./XcodeSetup";

const m = vi.hoisted(() => ({
  session: null as unknown,
  view: null as unknown,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: {} }),
}));
vi.mock("~/state/apple", () => ({
  appleEnvironment: {
    idStart: "start",
    idCancel: "cancel",
    idComplete: "complete",
    idRequestCode: "code",
    idSignOut: "signOut",
    idSession: () => "session",
  },
}));
vi.mock("~/state/xcode", () => ({
  xcodeEnvironment: {
    approve: "approve",
    retry: "retry",
    cancel: "cancel",
    install: "install",
    installRuntimes: "runtimes",
    view: () => "view",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (key: string) => (key === "session" ? m.session : m.view),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    label: "Studio Mac",
    descriptor: { platform: { os: "darwin" } },
    connection: { phase: "connected" },
  }),
}));
vi.mock("~/cloud/appleAccounts", () => ({
  appleAccountFunctions: { listAccounts: "list" },
  useAppleAccountsClient: () => ({}),
  useAppleCloudQuery: () => ({
    data: [
      { id: "apple", email: "dev@example.test", displayName: "Dev", scope: { kind: "personal" } },
    ],
  }),
}));
vi.mock("~/components/settings/company/useCompanySettings", () => ({
  useCompanySettings: () => ({ contentCompanyId: "company", isAuthLoaded: true, isSignedIn: true }),
}));
vi.mock("~/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("~/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));
vi.mock("~/components/ui/progress", () => ({ Progress: () => null }));
vi.mock("~/components/ui/badge", () => ({
  Badge: (props: Record<string, unknown>) => createElement("span", props),
}));
vi.mock("~/components/ui/select", () => ({
  Select: () => null,
  SelectItem: () => null,
  SelectPopup: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const { XcodeSetupFlow } = await import("./XcodeSetup");

// A minimal in-memory React host, as in RemoteBrowserView.test.tsx.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  private ownText = "";

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(value: string) {
    this.ownText = value;
    this.childNodes = [];
  }

  get textContent(): string {
    return this.ownText + this.childNodes.map((child) => child.textContent).join("");
  }

  set nodeValue(value: string) {
    this.ownText = value;
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: TestNode, before: TestNode) {
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  createElementNS(_namespace: string, name: string) {
    return this.createElement(name);
  }

  createTextNode(text: string) {
    const node = new TestNode("#text", this, 3);
    node.textContent = text;
    return node;
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

interface ButtonProps {
  readonly disabled?: boolean;
  readonly onClick?: () => unknown;
}

function reactProps(node: TestNode): ButtonProps {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, ButtonProps>)[key]! : {};
}

function allNodes(node: TestNode): TestNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

function findButton(root: TestNode, text: string): TestNode | undefined {
  return allNodes(root).find((node) => node.tagName === "BUTTON" && node.textContent === text);
}

const unmounts: Array<() => Promise<void>> = [];

async function mount(element: ReactNode): Promise<TestNode> {
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  // React's focus bookkeeping checks `instanceof window.HTMLIFrameElement`.
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: TestNode,
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  unmounts.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(element));
  return container;
}

const environmentId = EnvironmentId.make("env");

function sessionView(data: AppleIdSessionView["data"], error: string | null): AppleIdSessionView {
  return { data, error, isPending: false, refresh: vi.fn() };
}

function status(overrides: Partial<XcodeStatus> = {}): XcodeStatus {
  return {
    host: "mac",
    installed: [],
    available: [
      {
        id: "17B55",
        version: "26.1",
        build: "17B55",
        beta: false,
        downloadBytes: null,
        requiredBytes: 45e9,
      },
    ],
    runtimes: [],
    disk: { freeBytes: 200e9, requiredBytes: 45e9 },
    job: null,
    error: null,
    ...overrides,
  } as XcodeStatus;
}

describe("XcodeSetupFlow", () => {
  beforeEach(() => {
    m.view = {
      data: { status: status(), job: null },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  });

  afterEach(async () => {
    for (const unmount of unmounts.splice(0)) await unmount();
    vi.unstubAllGlobals();
  });

  it("shows a session stream error with Try again instead of the install form", async () => {
    const session = sessionView(
      { state: "authenticated", expiresAt: 12345 },
      "Session stream failed",
    );
    m.session = session;
    const root = await mount(<XcodeSetupFlow environmentId={environmentId} />);

    expect(root.textContent).toContain("Session stream failed");
    expect(findButton(root, "Install Xcode 26.1")).toBeUndefined();
    const retry = findButton(root, "Try again");
    expect(retry).toBeDefined();
    await act(async () => reactProps(retry!).onClick?.());
    expect(session.refresh).toHaveBeenCalledOnce();
  });

  it("offers the install once the session is healthy", async () => {
    m.session = sessionView({ state: "authenticated", expiresAt: 12345 }, null);
    const root = await mount(<XcodeSetupFlow environmentId={environmentId} />);

    expect(findButton(root, "Try again")).toBeUndefined();
    expect(reactProps(findButton(root, "Install Xcode 26.1")!).disabled).toBe(false);
  });
});
