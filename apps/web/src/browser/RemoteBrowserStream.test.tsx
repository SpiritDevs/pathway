import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  result: null as unknown,
  refresh: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.result,
  useAtomRefresh: () => mocks.refresh,
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { remoteFrames: (target: unknown) => target },
}));

import { RemoteBrowserStream } from "./RemoteBrowserStream";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;

const failure = (waiting = false) =>
  AsyncResult.failure(Cause.fail(new Error("The environment browser has stopped.")), {
    waiting,
  });

// ReactDOM needs a host, but this unit suite intentionally has no DOM dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }
  set textContent(_value: string) {}
  appendChild(child: TestNode) {
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: TestNode, before: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    return child;
  }
  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    return child;
  }
  createElement(name: string) {
    return new TestNode(name, this);
  }
  createTextNode() {
    return new TestNode("#text", this, 3);
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

describe("RemoteBrowserStream", () => {
  beforeEach(() => {
    mocks.refresh.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("offers Reconnect instead of an endless spinner when the stream fails", () => {
    mocks.result = failure();
    const markup = renderToStaticMarkup(
      <RemoteBrowserStream threadRef={threadRef} tabId="remote-1" />,
    );
    expect(markup).toContain("The remote browser disconnected.");
    expect(markup).toContain("The environment browser has stopped.");
    expect(markup).toContain("Reconnect");
  });

  it("retries a failed stream a bounded number of times on its own", async () => {
    mocks.result = failure();
    const document = new TestNode("#document", null, 9);
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", {
      document,
      HTMLIFrameElement: TestNode,
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal("HTMLIFrameElement", TestNode);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.createElement("div") as unknown as Element);
    try {
      await act(async () => {
        root.render(<RemoteBrowserStream threadRef={threadRef} tabId="remote-1" compact />);
      });
      // Each retry schedules the next only after React commits, so step between acts.
      for (let step = 0; step < 6; step += 1) {
        await act(() => vi.advanceTimersByTimeAsync(10_000));
      }
      expect(mocks.refresh).toHaveBeenCalledTimes(3);
    } finally {
      await act(() => root.unmount());
    }
  });
});
