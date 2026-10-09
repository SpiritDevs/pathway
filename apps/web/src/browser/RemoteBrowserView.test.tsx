import { EnvironmentId, ThreadId, type PreviewRemoteCommand } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type CommandResult =
  | { readonly _tag: "Success"; readonly value: object }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> };

const mocks = vi.hoisted(() => ({
  command: vi.fn(
    async (_input: { input: PreviewRemoteCommand }): Promise<CommandResult> => ({
      _tag: "Success",
      value: { tabs: [], selectedTabId: null },
    }),
  ),
  streamRendered: vi.fn(),
}));

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { remoteCommand: {} } }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { requestBrowserTakeover: {} } }));
vi.mock("~/state/entities", () => ({ useThreadProjection: () => null }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "Studio Mac" }),
  useEnvironmentHttpBaseUrl: () => "https://studio.example",
}));
vi.mock("~/browserHistoryStore", () => ({
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: 50,
  recordVisitForThread: vi.fn(),
  useThreadRecentHistory: () => [],
}));
vi.mock("~/components/preview/PreviewEmptyState", () => ({ PreviewEmptyState: () => null }));
vi.mock("./BrowserSavedLoginPicker", () => ({ BrowserSavedLoginPicker: () => null }));
vi.mock("./RemoteBrowserStream", () => ({
  RemoteBrowserStream: () => {
    mocks.streamRendered();
    return null;
  },
}));

import { RemoteBrowserView } from "./RemoteBrowserView";
import { useRemoteBrowserStore } from "./remoteBrowserStore";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;

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

async function render() {
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: TestNode,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("HTMLIFrameElement", TestNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(<RemoteBrowserView threadRef={threadRef} visible />);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

const actions = () => mocks.command.mock.calls.map(([call]) => call.input.action);

describe("RemoteBrowserView", () => {
  beforeEach(() => {
    mocks.command.mockClear();
    mocks.streamRendered.mockClear();
    useRemoteBrowserStore.setState({ byThreadKey: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes the agent to the environment browser before streaming it", async () => {
    let finish!: (result: CommandResult) => void;
    mocks.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = await render();
    try {
      expect(mocks.command.mock.calls[0]?.[0].input).toEqual({
        action: "selectHost",
        threadId: threadRef.threadId,
        host: "environment",
      });
      expect(mocks.streamRendered).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain("Remote · Studio Mac");

      await act(async () => finish({ _tag: "Success", value: {} }));
      expect(mocks.streamRendered).toHaveBeenCalled();
      expect(actions()).toEqual(["selectHost", "list"]);
    } finally {
      await view.unmount();
    }
  });

  it("keeps the browser watchable when the agent's browser cannot be claimed", async () => {
    mocks.command.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Finish the browser action before switching hosts.")),
    });
    const view = await render();
    try {
      expect(mocks.streamRendered).toHaveBeenCalled();
      expect(view.container.textContent).toContain(
        "Finish the browser action before switching hosts.",
      );
    } finally {
      await view.unmount();
    }
  });

  it("opens a URL requested from elsewhere once connected, exactly once", async () => {
    useRemoteBrowserStore.getState().requestOpen(threadRef, "http://localhost:3000/");
    const view = await render();
    try {
      const opens = mocks.command.mock.calls
        .map(([call]) => call.input)
        .filter((input) => input.action === "open");
      expect(opens).toEqual([
        { action: "open", threadId: threadRef.threadId, url: "http://localhost:3000/" },
      ]);
      expect(useRemoteBrowserStore.getState().takePendingUrl(threadRef)).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
