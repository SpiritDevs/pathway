// @effect-diagnostics nodeBuiltinImport:off - Native browser adapter tests use isolated temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BrowserContext, Page, chromium } from "playwright";
import { ThreadId, type PreviewRemoteFrame } from "@spiritdevs/contracts";
import {
  REMOTE_BROWSER_CAPTURE_MAX_COUNT,
  REMOTE_BROWSER_CAPTURE_MAX_BYTES,
  RemoteBrowserRuntime,
} from "./RemoteBrowserRuntime.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function browserFixture() {
  const pageEvents = new NodeEvents.EventEmitter();
  const contextEvents = new NodeEvents.EventEmitter();
  const cdpEvents = new NodeEvents.EventEmitter();
  let closed = false;
  let url = "about:blank";
  const documentState = { readyState: "complete" };
  const mainFrame = {};
  const cdp = {
    on: cdpEvents.on.bind(cdpEvents),
    send: vi.fn(async (_method: string) => undefined),
    detach: vi.fn(async () => undefined),
  };
  const context = {
    on: contextEvents.on.bind(contextEvents),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    pages: () => [page as unknown as Page],
    newPage: vi.fn(async () => page as unknown as Page),
    newCDPSession: vi.fn(async () => cdp),
    close: vi.fn(async () => {
      contextEvents.emit("close");
    }),
  };
  const locator = {
    click: vi.fn(async (_options?: { timeout?: number }) => undefined),
    fill: vi.fn(async (_text: string, _options?: { timeout?: number }) => undefined),
    pressSequentially: vi.fn(async (_text: string, _options?: { timeout?: number }) => undefined),
    waitFor: vi.fn(async (_options?: { timeout?: number }) => undefined),
    innerText: vi.fn(async () => "Example"),
    ariaSnapshot: vi.fn(async () => "- document"),
  };
  const page = {
    mainFrame: () => mainFrame,
    locator: () => locator,
    getByText: () => ({ first: () => locator }),
    waitForURL: vi.fn(async (_predicate: unknown, _options?: { timeout?: number }) => undefined),
    on: pageEvents.on.bind(pageEvents),
    opener: async () => null,
    isClosed: () => closed,
    url: () => url,
    title: vi.fn(async () => "Example"),
    screenshot: vi.fn(async (options?: { path?: string }) => {
      if (options?.path) await NodeFSP.writeFile(options.path, "test-image");
      return Buffer.from("jpeg");
    }),
    viewportSize: () => ({ width: 1280, height: 800 }),
    context: () => context,
    goto: vi.fn(async (next: string) => {
      url = next;
      pageEvents.emit("framenavigated", mainFrame);
    }),
    close: vi.fn(async () => {
      closed = true;
      pageEvents.emit("close");
    }),
    mouse: { click: vi.fn(async () => undefined) },
    evaluate: vi.fn(
      async (expression: string): Promise<unknown> =>
        expression === "document.readyState !== 'complete'"
          ? documentState.readyState !== "complete"
          : null,
    ),
  };
  const launch = vi.fn(
    async () => context as unknown as BrowserContext,
  ) as unknown as typeof chromium.launchPersistentContext;
  return { page, pageEvents, mainFrame, locator, cdp, cdpEvents, context, launch, documentState };
}
const threadId = ThreadId.make("browser-lifecycle-test");

describe("RemoteBrowserRuntime lifecycle", () => {
  let directory: string;
  let runtime: RemoteBrowserRuntime | undefined;
  beforeEach(async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-browser-test-"));
  });
  afterEach(async () => {
    await runtime?.close();
    vi.useRealTimers();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });

  it("watches task metadata without launching Chromium and reports newly opened pages", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const frames: PreviewRemoteFrame[] = [];
    const unsubscribe = await runtime.subscribe(threadId, undefined, (frame) => frames.push(frame));
    expect(fixture.launch).not.toHaveBeenCalled();
    expect(frames.at(-1)?.tabs).toEqual([]);
    await runtime.command({ action: "open", threadId, url: "https://example.com" });
    expect(frames.at(-1)?.tabs?.[0]?.url).toBe("https://example.com/");
    expect(frames.every((frame) => frame.data === "")).toBe(true);
    await unsubscribe();
  });

  it("closes Chromium after the final tab and does not relaunch for stale actions", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    await runtime.command({ action: "close", threadId, tabId: tabs[0]!.tabId });
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect((await runtime.list(threadId)).tabs).toEqual([]);
    await expect(
      runtime.command({ action: "click", threadId, tabId: tabs[0]!.tabId, x: 0, y: 0 }),
    ).rejects.toThrow("closed");
    expect(fixture.launch).toHaveBeenCalledOnce();
  });

  it.each(["page", "context"] as const)(
    "notifies the selected-tab subscriber when its %s closes",
    async (closedSurface) => {
      const fixture = browserFixture();
      runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
      const { tabs } = await runtime.command({ action: "open", threadId });
      const frames: PreviewRemoteFrame[] = [];
      const removed = deferred();
      const unsubscribe = await runtime.subscribe(threadId, tabs[0]!.tabId, (frame) => {
        frames.push(frame);
        if (frame.tabs?.length === 0) removed.resolve();
      });
      expect(frames.at(-1)?.tabs?.length).toBe(1);
      if (closedSurface === "page") await fixture.page.close();
      else await fixture.context.close();
      await removed.promise;
      expect(frames.at(-1)?.tabs).toEqual([]);
      expect(frames.at(-1)?.data).toBe("");
      await unsubscribe();
    },
  );

  it("bounds simultaneously active browser contexts without evicting open tabs", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    for (let index = 0; index < 8; index++) {
      await runtime.command({ action: "open", threadId: ThreadId.make(`limit-${index}`) });
    }
    await expect(runtime.command({ action: "open", threadId })).rejects.toThrow("Eight tasks");
    expect(fixture.launch).toHaveBeenCalledTimes(8);
    expect(fixture.context.close).not.toHaveBeenCalled();
  });

  it("shares capture initialization and publishes the last coalesced frame", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const state = await runtime.command({ action: "open", threadId });
    const tabId = state.tabs[0]!.tabId;
    const started = deferred();
    const release = deferred();
    fixture.cdp.send.mockImplementation(async (method) => {
      if (method === "Page.startScreencast") {
        started.resolve();
        await release.promise;
      }
    });
    const firstFrames: PreviewRemoteFrame[] = [];
    const first = runtime.subscribe(threadId, tabId, (frame) => firstFrames.push(frame));
    await started.promise;
    let secondReady = false;
    const second = runtime
      .subscribe(threadId, tabId, () => undefined)
      .then((value) => {
        secondReady = true;
        return value;
      });
    await Promise.resolve();
    expect(secondReady).toBe(false);
    expect(fixture.context.newCDPSession).toHaveBeenCalledOnce();
    release.resolve();
    const [unsubscribeFirst, unsubscribeSecond] = await Promise.all([first, second]);
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    fixture.cdpEvents.emit("Page.screencastFrame", { sessionId: 1, data: "first" });
    vi.setSystemTime(1050);
    fixture.cdpEvents.emit("Page.screencastFrame", { sessionId: 2, data: "last" });
    expect(firstFrames.at(-1)?.data).toBe("first");
    await vi.advanceTimersByTimeAsync(160);
    expect(firstFrames.at(-1)?.data).toBe("last");
    await unsubscribeFirst();
    await unsubscribeSecond();
    expect(fixture.cdp.detach).toHaveBeenCalledOnce();
  });

  it("retains current metadata when the latest image replaces a metadata-only frame", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    let latest: PreviewRemoteFrame | undefined;
    const unsubscribe = await runtime.subscribe(threadId, tabs[0]!.tabId, (frame) => {
      latest = frame;
    });
    const initialRevision = latest!.metadataRevision!;
    await runtime.command({
      action: "navigate",
      threadId,
      tabId: tabs[0]!.tabId,
      url: "https://example.com/next",
    });
    const titleReads = fixture.page.title.mock.calls.length;
    fixture.cdpEvents.emit("Page.screencastFrame", { sessionId: 1, data: "latest-image" });
    expect(latest?.data).toBe("latest-image");
    expect(latest?.tabs?.[0]?.url).toBe("https://example.com/next");
    expect(latest!.metadataRevision!).toBeGreaterThan(initialRevision);
    expect(fixture.page.title).toHaveBeenCalledTimes(titleReads);
    await unsubscribe();
  });

  it("publishes a new metadata revision when a closed tab finishes recording", async () => {
    const fixture = browserFixture();
    const encoder = NodePath.join(directory, "test-encoder");
    await NodeFSP.writeFile(
      encoder,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => { require("node:fs").writeFileSync(process.argv.at(-1), "test-video"); });\n`,
      { mode: 0o700 },
    );
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch, encoder);
    const { tabs } = await runtime.command({ action: "open", threadId });
    const finalized = deferred();
    const emptyRevisions: number[] = [];
    const unsubscribe = await runtime.subscribe(threadId, tabs[0]!.tabId, (frame) => {
      if (frame.tabs?.length === 0 && frame.metadataRevision !== undefined) {
        emptyRevisions.push(frame.metadataRevision);
        if (emptyRevisions.length === 2) finalized.resolve();
      }
    });
    await runtime.command({ action: "recordingStart", threadId, tabId: tabs[0]!.tabId });
    await fixture.page.close();
    await finalized.promise;
    expect(emptyRevisions[1]!).toBeGreaterThan(emptyRevisions[0]!);
    const state = await runtime.list(threadId);
    expect(state.tabs).toEqual([]);
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]?.mimeType).toBe("video/mp4");
    const read = {
      requestId: "read-closed-recording",
      threadId,
      tabId: tabs[0]!.tabId,
      operation: "recordingStop" as const,
      input: { path: state.artifacts[0]!.path, offset: 0, length: 1024 },
      timeoutMs: 1000,
    };
    await expect(runtime.automate(read)).resolves.toEqual({
      data: Buffer.from("test-video").toString("base64"),
      offset: 0,
      nextOffset: 10,
      totalBytes: 10,
    });
    await expect(
      runtime.automate({ ...read, threadId: ThreadId.make("different-owner") }),
    ).rejects.toThrow("Unknown browser recording artifact");
    expect(fixture.launch).toHaveBeenCalledOnce();
    await unsubscribe();
    await runtime.close();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch, encoder);
    expect((await runtime.list(threadId)).artifacts).toEqual(state.artifacts);
    await expect(runtime.automate(read)).resolves.toMatchObject({ totalBytes: 10 });
    await expect(
      runtime.automate({ ...read, threadId: ThreadId.make("different-owner") }),
    ).rejects.toThrow("Unknown browser recording artifact");
    expect(fixture.launch).toHaveBeenCalledOnce();
  });

  it("recovers saved screenshots without launching a browser and skips retained-index files removed by cleanup", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    const result = await runtime.command({ action: "screenshot", threadId, tabId: tabs[0]!.tabId });
    const artifact = result.artifact!;
    await runtime.close();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    expect((await runtime.list(threadId)).artifacts).toEqual([artifact]);
    expect((await runtime.list("other-owner")).artifacts).toEqual([]);
    expect(fixture.launch).toHaveBeenCalledOnce();
    await runtime.close();
    await NodeFSP.unlink(artifact.path);
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    expect((await runtime.list(threadId)).artifacts).toEqual([]);
  });

  it("closes a task during startup, frees capacity, and rejects the late-created context", async () => {
    const first = browserFixture();
    const started = deferred();
    const release = deferred();
    let count = 0;
    const launch = vi.fn(async () => {
      if (count++ === 0) {
        started.resolve();
        await release.promise;
        return first.context as unknown as BrowserContext;
      }
      return browserFixture().context as unknown as BrowserContext;
    });
    runtime = new RemoteBrowserRuntime(directory, directory, launch);
    const opening = runtime.command({ action: "open", threadId });
    const failed = expect(opening).rejects.toThrow("stopped");
    await started.promise;
    const closing = runtime.closeThread(threadId);
    expect(runtime.closeThread(threadId)).toBe(closing);
    for (let index = 0; index < 8; index++)
      await runtime.command({ action: "open", threadId: ThreadId.make(`replacement-${index}`) });
    release.resolve();
    await closing;
    await failed;
    expect(first.context.close).toHaveBeenCalledOnce();
    await expect(runtime.command({ action: "open", threadId })).rejects.toThrow("closed");
  });

  it("stops an active recording on task deletion and removes captures without touching unrelated attachments", async () => {
    const fixture = browserFixture();
    const encoder = NodePath.join(directory, "closing-encoder");
    await NodeFSP.writeFile(
      encoder,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => { require("node:fs").writeFileSync(process.argv.at(-1), "closed-task-video"); });\n`,
      { mode: 0o700 },
    );
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch, encoder);
    const { tabs } = await runtime.command({ action: "open", threadId });
    await runtime.command({ action: "recordingStart", threadId, tabId: tabs[0]!.tabId });
    await NodeFSP.writeFile(NodePath.join(directory, "unrelated-attachment.png"), "keep");
    await runtime.closeThread(threadId);
    expect(fixture.context.close).toHaveBeenCalledOnce();
    const state = await runtime.list(threadId);
    expect(state.tabs).toEqual([]);
    expect(state.artifacts).toEqual([]);
    expect((await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".mp4"))).toEqual([]);
    expect(
      await NodeFSP.readFile(NodePath.join(directory, "unrelated-attachment.png"), "utf8"),
    ).toBe("keep");
    await runtime.close();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch, encoder);
    expect((await runtime.list(threadId)).artifacts).toEqual(state.artifacts);
    expect(fixture.launch).toHaveBeenCalledOnce();
  });

  it("removes a partially written failed screenshot instead of leaving an unindexed file", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    fixture.page.screenshot.mockImplementationOnce(async (options) => {
      if (options?.path) await NodeFSP.writeFile(options.path, "partial-capture");
      throw new Error("Capture failed");
    });
    await expect(
      runtime.command({ action: "screenshot", threadId, tabId: tabs[0]!.tabId }),
    ).rejects.toThrow("Capture failed");
    expect((await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".png"))).toEqual([]);
    expect((await runtime.list(threadId)).artifacts).toEqual([]);
  });

  it("prunes oldest capture files and index entries once the per-task count is reached", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    const paths: string[] = [];
    for (let count = 0; count <= REMOTE_BROWSER_CAPTURE_MAX_COUNT; count++) {
      const result = await runtime.command({
        action: "screenshot",
        threadId,
        tabId: tabs[0]!.tabId,
      });
      paths.push(result.artifact!.path);
    }
    const retained = (await runtime.list(threadId)).artifacts;
    expect(retained.map((artifact) => artifact.path)).toEqual(paths.slice(1));
    await expect(NodeFSP.stat(paths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    const indexPath = NodePath.join(
      directory,
      "captures",
      (await NodeFSP.readdir(NodePath.join(directory, "captures")))[0]!,
    );
    expect(await NodeFSP.readFile(indexPath, "utf8")).not.toContain(NodePath.basename(paths[0]!));
    await runtime.close();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    expect((await runtime.list(threadId)).artifacts).toEqual(retained);
    expect(fixture.launch).toHaveBeenCalledOnce();
  });

  it.each(["save", "restart"] as const)(
    "enforces the byte limit on %s and task deletion removes only recovered owned files",
    async (enforcement) => {
      const fixture = browserFixture();
      runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
      const { tabs } = await runtime.command({ action: "open", threadId });
      if (enforcement === "save")
        fixture.page.screenshot.mockImplementation(async (options) => {
          if (options?.path) {
            await NodeFSP.writeFile(options.path, "test-image");
            await NodeFSP.truncate(options.path, REMOTE_BROWSER_CAPTURE_MAX_BYTES / 2 + 1);
          }
          return Buffer.from("jpeg");
        });
      const first = (
        await runtime.command({ action: "screenshot", threadId, tabId: tabs[0]!.tabId })
      ).artifact!;
      const second = (
        await runtime.command({ action: "screenshot", threadId, tabId: tabs[0]!.tabId })
      ).artifact!;
      // Sparse files reproduce an oversized old index without allocating the capture bytes.
      if (enforcement === "restart") {
        await NodeFSP.truncate(first.path, REMOTE_BROWSER_CAPTURE_MAX_BYTES / 2 + 1);
        await NodeFSP.truncate(second.path, REMOTE_BROWSER_CAPTURE_MAX_BYTES / 2 + 1);
      } else {
        await expect(NodeFSP.stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const unrelated = NodePath.join(directory, "ordinary-upload.png");
      await NodeFSP.writeFile(unrelated, "keep");
      await runtime.close();
      runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
      const retained = (await runtime.list(threadId)).artifacts;
      expect(retained.map((artifact) => artifact.path)).toEqual([second.path]);
      await expect(NodeFSP.stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
      await runtime.closeThread(threadId);
      await expect(NodeFSP.stat(second.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await NodeFSP.readFile(unrelated, "utf8")).toBe("keep");
      expect(await NodeFSP.readdir(NodePath.join(directory, "captures"))).toEqual([]);
      expect(fixture.launch).toHaveBeenCalledOnce();
    },
  );

  it("reports committed and interactive documents as loading until the document completes", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    const request = { requestId: "readiness", threadId, tabId: tabs[0]!.tabId, timeoutMs: 1000 };
    fixture.page.goto.mockImplementationOnce(async () => {
      fixture.documentState.readyState = "loading";
    });
    await expect(
      runtime.automate({
        ...request,
        operation: "navigate",
        input: { url: "https://example.com", readiness: "none" },
      }),
    ).resolves.toMatchObject({ loading: true });
    for (const readyState of ["interactive", "complete"]) {
      fixture.documentState.readyState = readyState;
      await expect(
        runtime.automate({ ...request, operation: "status", input: {} }),
      ).resolves.toMatchObject({ loading: readyState !== "complete" });
      await expect(
        runtime.automate({ ...request, operation: "snapshot", input: {} }),
      ).resolves.toMatchObject({ loading: readyState !== "complete" });
    }
    const navigationRequest = { isNavigationRequest: () => true, frame: () => fixture.mainFrame };
    fixture.pageEvents.emit("request", navigationRequest);
    await expect(
      runtime.automate({ ...request, operation: "status", input: {} }),
    ).resolves.toMatchObject({ loading: true });
    fixture.pageEvents.emit("requestfailed", navigationRequest);
    await expect(
      runtime.automate({ ...request, operation: "status", input: {} }),
    ).resolves.toMatchObject({ loading: false });
    fixture.pageEvents.emit("request", { isNavigationRequest: () => true, frame: () => ({}) });
    await expect(
      runtime.automate({ ...request, operation: "status", input: {} }),
    ).resolves.toMatchObject({ loading: false });
    fixture.pageEvents.emit("request", navigationRequest);
    fixture.pageEvents.emit("requestfinished", navigationRequest);
    await expect(
      runtime.automate({ ...request, operation: "status", input: {} }),
    ).resolves.toMatchObject({ loading: false });
    fixture.page.evaluate.mockRejectedValueOnce(new Error("Execution context replaced"));
    await expect(
      runtime.automate({ ...request, operation: "status", input: {} }),
    ).resolves.toMatchObject({ loading: true });
  });

  it("cancels queued actions when the owning task is closed", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    const started = deferred();
    const release = deferred();
    fixture.page.goto.mockImplementation(async () => {
      started.resolve();
      await release.promise;
    });
    const navigation = runtime.command({
      action: "navigate",
      threadId,
      tabId: tabs[0]!.tabId,
      url: "https://example.com",
    });
    await started.promise;
    const click = runtime.command({ action: "click", threadId, tabId: tabs[0]!.tabId, x: 1, y: 1 });
    const rejected = expect(click).rejects.toThrow("closed");
    await runtime.closeThread(threadId);
    release.resolve();
    await navigation;
    await rejected;
    expect(fixture.page.mouse.click).not.toHaveBeenCalled();
    expect(fixture.context.close).toHaveBeenCalledOnce();
  });

  it("limits queued navigation to the remaining deadline and honors a shorter navigation budget", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    const started = deferred();
    const release = deferred();
    fixture.page.mouse.click.mockImplementation(async () => {
      started.resolve();
      await release.promise;
    });
    const click = runtime.command({ action: "click", threadId, tabId: tabs[0]!.tabId, x: 1, y: 1 });
    await started.promise;
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const navigation = runtime.automate({
      requestId: "queued-navigation",
      threadId,
      tabId: tabs[0]!.tabId,
      operation: "navigate",
      input: { url: "https://example.com", timeoutMs: 15000 },
      timeoutMs: 1000,
    });
    vi.setSystemTime(1900);
    release.resolve();
    await click;
    await navigation;
    expect(fixture.page.goto).toHaveBeenLastCalledWith(
      "https://example.com/",
      expect.objectContaining({ timeout: 100 }),
    );
    await runtime.automate({
      requestId: "short-navigation",
      threadId,
      tabId: tabs[0]!.tabId,
      operation: "navigate",
      input: { url: "https://example.com", timeoutMs: 50 },
      timeoutMs: 1000,
    });
    expect(fixture.page.goto).toHaveBeenLastCalledWith(
      "https://example.com/",
      expect.objectContaining({ timeout: 50 }),
    );
  });

  it.each(["click", "fill", "type", "waitFor"] as const)(
    "shares the queued request deadline with locator %s",
    async (operation) => {
      const fixture = browserFixture();
      runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
      const { tabs } = await runtime.command({ action: "open", threadId });
      const started = deferred();
      const release = deferred();
      fixture.page.mouse.click.mockImplementation(async () => {
        started.resolve();
        await release.promise;
      });
      const click = runtime.command({
        action: "click",
        threadId,
        tabId: tabs[0]!.tabId,
        x: 1,
        y: 1,
      });
      await started.promise;
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const input =
        operation === "waitFor"
          ? { selector: "#login", text: "ready", urlIncludes: "done" }
          : operation === "click"
            ? { selector: "#login" }
            : { selector: "#login", text: "example", clear: operation === "fill" };
      fixture.locator.waitFor.mockImplementationOnce(async () => {
        vi.setSystemTime(1750);
      });
      fixture.locator.waitFor.mockImplementationOnce(async () => {
        vi.setSystemTime(1900);
      });
      const action = runtime.automate({
        requestId: "queued-locator",
        threadId,
        tabId: tabs[0]!.tabId,
        operation: operation === "fill" ? "type" : operation,
        input,
        timeoutMs: 1000,
      });
      vi.setSystemTime(1400);
      release.resolve();
      await click;
      await action;
      if (operation === "click")
        expect(fixture.locator.click).toHaveBeenCalledWith({ timeout: 600 });
      else if (operation === "fill")
        expect(fixture.locator.fill).toHaveBeenCalledWith("example", { timeout: 600 });
      else if (operation === "type")
        expect(fixture.locator.pressSequentially).toHaveBeenCalledWith("example", { timeout: 600 });
      else {
        expect(fixture.locator.waitFor).toHaveBeenNthCalledWith(1, {
          state: "attached",
          timeout: 600,
        });
        expect(fixture.locator.waitFor).toHaveBeenNthCalledWith(2, { timeout: 250 });
        expect(fixture.page.waitForURL).toHaveBeenCalledWith(expect.any(Function), {
          timeout: 100,
        });
      }
    },
  );

  it("revalidates takeover after a human action waits in the tab queue", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    const tabId = tabs[0]!.tabId;
    const started = deferred();
    const release = deferred();
    fixture.page.goto.mockImplementation(async () => {
      started.resolve();
      await release.promise;
    });
    const navigation = runtime.command({
      action: "navigate",
      threadId,
      tabId,
      url: "https://example.com",
    });
    await started.promise;
    let allowed = true;
    const click = runtime.command({ action: "click", threadId, tabId, x: 10, y: 10 }, async () => {
      if (!allowed) throw new Error("Takeover ended");
    });
    const rejected = expect(click).rejects.toThrow("Takeover ended");
    allowed = false;
    release.resolve();
    await navigation;
    await rejected;
    expect(fixture.page.mouse.click).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "queues agent open behind the current tab action (expired: %s)",
    async (expired) => {
      const fixture = browserFixture();
      runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
      const { tabs } = await runtime.command({ action: "open", threadId });
      const tabId = tabs[0]!.tabId;
      const started = deferred();
      const release = deferred();
      fixture.page.mouse.click.mockImplementation(async () => {
        started.resolve();
        await release.promise;
      });
      const click = runtime.command({ action: "click", threadId, tabId, x: 1, y: 1 });
      await started.promise;
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const open = runtime.automate({
        requestId: "queued-open",
        threadId,
        tabId,
        operation: "open",
        input: { url: "https://example.com", reuseExistingTab: true },
        timeoutMs: 1000,
      });
      const result = expired
        ? expect(open).rejects.toThrow("expired")
        : expect(open).resolves.toMatchObject({ tabId });
      await Promise.resolve();
      await Promise.resolve();
      expect(fixture.page.goto).not.toHaveBeenCalled();
      if (expired) vi.setSystemTime(2001);
      release.resolve();
      await click;
      await result;
      expect(fixture.page.goto).toHaveBeenCalledTimes(expired ? 0 : 1);
    },
  );

  it("closes the execution context when an async script exceeds its request budget", async () => {
    const fixture = browserFixture();
    runtime = new RemoteBrowserRuntime(directory, directory, fixture.launch);
    const { tabs } = await runtime.command({ action: "open", threadId });
    const tabId = tabs[0]!.tabId;
    const started = deferred();
    fixture.page.evaluate.mockImplementation(async () => {
      started.resolve();
      return new Promise(() => undefined);
    });
    vi.useFakeTimers();
    const execution = runtime.automate({
      requestId: "evaluate-timeout",
      threadId,
      tabId,
      operation: "evaluate",
      input: { expression: "new Promise(() => {})" },
      timeoutMs: 1000,
    });
    const failed = expect(execution).rejects.toThrow("Browser script timed out");
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(fixture.page.close).toHaveBeenCalledOnce();
    expect((await runtime.list(threadId)).tabs).toEqual([]);
  });
});
