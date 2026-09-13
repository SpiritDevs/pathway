import { act, StrictMode } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{ closed: boolean }>,
  getToken: vi.fn(),
  userId: "one",
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken: mocks.getToken, isSignedIn: true, userId: mocks.userId }),
}));
vi.mock("../../cloud/publicConfig", () => ({
  resolveCloudSyncConvexUrl: () => "https://example.convex.cloud",
}));
vi.mock("../../cloud/syncTransportAuth", () => ({
  makeClerkConvexTokenFetcher: () => mocks.getToken,
}));
vi.mock("convex/browser", () => ({
  ConvexClient: class {
    closed = false;
    constructor() {
      mocks.clients.push(this);
    }
    setAuth() {}
    async close() {
      this.closed = true;
    }
    onUpdate(_ref: unknown, _args: unknown, update: (value: string[]) => void) {
      if (!this.closed) update(["recorded run"]);
      return () => {};
    }
  },
}));
import { useBusinessToolsCloud, useBusinessToolsQuery } from "./businessToolsCloud";
// ReactDOM needs a host, but this unit suite intentionally has no DOM dependency.
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

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  get options() {
    return this.childNodes;
  }
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.clients.length = 0;
});
it("keeps queries connected after Strict Mode cleanup and closes clients on unmount", async () => {
  const document = installTestDom();
  const { createRoot } = await import("react-dom/client");
  let entries: string[] | undefined;
  function Probe() {
    const cloud = useBusinessToolsCloud();
    entries = useBusinessToolsQuery<string[]>(
      cloud.client,
      cloud.accountID,
      "timeTracking:listMine",
      {},
    ).value;
    return null;
  }
  const root = createRoot(document.createElement("div") as unknown as Element);
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    );
    expect(entries).toEqual(["recorded run"]);
    expect(mocks.clients.filter((client) => !client.closed)).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
  expect(mocks.clients.every((client) => client.closed)).toBe(true);
});
