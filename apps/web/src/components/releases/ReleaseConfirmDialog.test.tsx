import { EnvironmentId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import type { ReleaseIntent, ReleaseOrganizer as Organizer } from "@spiritdevs/contracts/releases";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const m = vi.hoisted(() => ({
  calls: [] as Array<string>,
  intent: null as unknown,
  publishing: { enabled: true, revision: 1 } as unknown,
  connected: true,
  executeResult: { _tag: "Success", value: { id: "job" } } as unknown,
}));

vi.mock("~/cloud/appleAccounts", () => ({
  useAppleAccountsClient: () => ({
    mutation: async (ref: string, args: unknown) => {
      m.calls.push(`cloud:${ref}:${JSON.stringify(args)}`);
      return {};
    },
  }),
  useAppleCloudQuery: (_client: unknown, ref: string, args: unknown) =>
    args === null
      ? { data: undefined, error: null }
      : { data: ref === "intent" ? m.intent : m.publishing, error: null },
}));
vi.mock("~/cloud/appleReleases", () => ({
  appleReleaseFunctions: {
    intent: "intent",
    settings: "settings",
    confirm: "confirm",
    cancel: "cancel",
    setEnabled: "setEnabled",
  },
}));
vi.mock("~/state/releases", () => ({
  releaseEnvironment: { execute: "execute", localStatus: () => "local" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (args: unknown) => {
    m.calls.push(`${command}:${JSON.stringify(args)}`);
    return m.executeResult;
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: true, refresh: vi.fn() }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    label: "Studio Mac",
    connection: { phase: m.connected ? "connected" : "disconnected" },
  }),
}));
vi.mock("~/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("~/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("~/components/ui/badge", () => ({
  Badge: (props: Record<string, unknown>) => createElement("span", props),
}));

const { ReleaseConfirmation } = await import("./ReleaseConfirmDialog");
const { ReleaseOrganizer } = await import("./ReleaseOrganizer");

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

const target = {
  companyId: CompanyId.make("company"),
  accountId: "account",
  teamId: "TEAM",
  appId: "app1",
};

function build(index: number): Organizer["builds"][number] {
  return {
    id: `b${index}`,
    version: "1.0",
    buildNumber: String(index),
    processingState: "VALID",
    expiresAt: null,
    uploadedDate: null,
    betaReviewState: null,
    internalBuildState: null,
    externalBuildState: null,
  };
}

function organizer(builds: number): Organizer {
  return {
    builds: Array.from({ length: builds }, (_, index) => build(index + 1)),
    groups: [{ id: "g1", name: "Staff", isInternalGroup: true }],
    testers: [],
    versions: [],
    reviews: [],
    fetchedAt: 0,
  };
}

function intent(overrides: Partial<ReleaseIntent> = {}): ReleaseIntent {
  return {
    id: "intent1",
    target,
    environmentId: "env",
    action: {
      kind: "testflight",
      buildId: "b1",
      groupIds: ["g1"],
      locale: "en-US",
      whatsNew: "Try the new tab",
      submitForReview: false,
    },
    state: "pending",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  } as ReleaseIntent;
}

const context = { appName: "Example", organizer: organizer(1), archives: [] };

describe("ReleaseConfirmation", () => {
  beforeEach(() => {
    m.calls = [];
    m.intent = intent();
    m.publishing = { enabled: true, revision: 1 };
    m.connected = true;
  });

  afterEach(async () => {
    for (const unmount of unmounts.splice(0)) await unmount();
    vi.unstubAllGlobals();
  });

  it("shows exactly what will be sent, then approves in Cloud before executing", async () => {
    const onDone = vi.fn();
    const root = await mount(
      <ReleaseConfirmation intentId="intent1" context={context} onDone={onDone} />,
    );

    expect(root.textContent).toContain("1.0 (1)");
    expect(root.textContent).toContain("Staff");
    expect(root.textContent).toContain("Try the new tab");
    expect(root.textContent).toContain("Studio Mac");
    await act(async () => reactProps(findButton(root, "Confirm and send")!).onClick?.());

    expect(m.calls).toEqual([
      `cloud:confirm:${JSON.stringify({ intentId: "intent1" })}`,
      `execute:${JSON.stringify({ environmentId: "env", input: { ...target, intentId: "intent1" } })}`,
    ]);
    expect(onDone).toHaveBeenCalledWith({ id: "job" });
  });

  it("cannot confirm while publishing is off, and Discard cancels the intent", async () => {
    m.publishing = { enabled: false, revision: 2 };
    const onDone = vi.fn();
    const root = await mount(
      <ReleaseConfirmation intentId="intent1" context={context} onDone={onDone} />,
    );

    expect(root.textContent).toContain("Publishing is off");
    expect(reactProps(findButton(root, "Confirm and send")!).disabled).toBe(true);
    await act(async () => reactProps(findButton(root, "Discard")!).onClick?.());
    expect(m.calls).toEqual([`cloud:cancel:${JSON.stringify({ intentId: "intent1" })}`]);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it("does not offer Confirm for an expired or used intent", async () => {
    m.intent = intent({ expiresAt: Date.now() - 1 });
    const expired = await mount(
      <ReleaseConfirmation intentId="intent1" context={context} onDone={vi.fn()} />,
    );
    expect(expired.textContent).toContain("expired");
    expect(reactProps(findButton(expired, "Confirm and send")!).disabled).toBe(true);

    m.intent = intent({ state: "consumed" });
    const used = await mount(
      <ReleaseConfirmation intentId="intent1" context={context} onDone={vi.fn()} />,
    );
    expect(used.textContent).toContain("already used");
    expect(findButton(used, "Confirm and send")).toBeUndefined();
    expect(findButton(used, "Close")).toBeDefined();
  });

  it("waits for the environment that prepared the intent", async () => {
    m.connected = false;
    const root = await mount(
      <ReleaseConfirmation intentId="intent1" context={context} onDone={vi.fn()} />,
    );
    expect(root.textContent).toContain("Connect to Studio Mac");
    expect(reactProps(findButton(root, "Confirm and send")!).disabled).toBe(true);
  });
});

describe("ReleaseOrganizer", () => {
  afterEach(async () => {
    for (const unmount of unmounts.splice(0)) await unmount();
    vi.unstubAllGlobals();
  });

  it("pages builds and uploads a local archive from its own environment", async () => {
    const onUpload = vi.fn();
    const archive = {
      id: "a1",
      version: "1.0",
      buildNumber: "13",
      scheme: "App",
      platform: "IOS",
      artifactBytes: 1024,
      createdAt: 0,
    };
    const root = await mount(
      <ReleaseOrganizer
        organizer={organizer(12)}
        error={null}
        target={target}
        selected={{
          environmentId: EnvironmentId.make("env"),
          local: { environmentLabel: "Studio Mac", archives: [archive], jobs: [] } as never,
        }}
        otherEnvironments={[]}
        busy={false}
        onUpload={onUpload}
      />,
    );

    expect(root.textContent).toContain("Page 1 of 2");
    expect(root.textContent).not.toContain("1.0 (11)");
    await act(async () => reactProps(findButton(root, "Next")!).onClick?.());
    expect(root.textContent).toContain("Page 2 of 2");
    expect(root.textContent).toContain("1.0 (11)");

    expect(root.textContent).toContain("On Studio Mac");
    await act(async () => reactProps(findButton(root, "Upload…")!).onClick?.());
    expect(onUpload).toHaveBeenCalledWith(archive, "env");
  });
});
