// @effect-diagnostics nodeBuiltinImport:off - native event emitters fake Playwright's event API.
import * as NodeEvents from "node:events";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  browserLaunchOptions,
  consoleCapture,
  make,
  PAGE_URL,
  requestPolicy,
  type HtmlPreviewBrowserDependencies,
} from "./HtmlPreviewBrowser.ts";

function deferred<A = void>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// The assertions below are confined to the fake native adapter, never Effects.
function fixture(
  input: { height?: number; evaluate?: () => Promise<unknown>; loadError?: Error } = {},
) {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const contextEvents = new NodeEvents.EventEmitter();
  const pages: Array<ReturnType<typeof newPage>> = [];
  let activePages = 0;
  let maxActivePages = 0;
  function newPage() {
    const events = new NodeEvents.EventEmitter();
    let closed = false;
    const frame = { page: () => page as unknown as Page, url: () => PAGE_URL };
    const page = {
      on: events.on.bind(events),
      opener: async () => null,
      isClosed: () => closed,
      mainFrame: () => frame,
      url: () => frame.url(),
      setViewportSize: vi.fn(async (_size: { width: number; height: number }) => {}),
      goto: vi.fn(async (_url: string) => {
        if (input.loadError) throw input.loadError;
        await request(PAGE_URL, page);
      }),
      evaluate: vi.fn(async (expression: string) =>
        expression.includes("document.fonts")
          ? input.evaluate
            ? input.evaluate()
            : true
          : (input.height ?? 123),
      ),
      screenshot: vi.fn(async (_options: Parameters<Page["screenshot"]>[0]) => Buffer.from("PNG")),
      close: vi.fn(async () => {
        if (!closed) {
          activePages -= 1;
          closed = true;
        }
      }),
    };
    activePages += 1;
    maxActivePages = Math.max(maxActivePages, activePages);
    contextEvents.emit("page", page);
    return { page, events };
  }
  const context = {
    on: contextEvents.on.bind(contextEvents),
    addInitScript: vi.fn(async (_source: string) => {}),
    route: vi.fn(async (_glob: string, callback: (route: Route) => Promise<void>) => {
      handler = callback;
    }),
    newPage: vi.fn(async () => {
      const created = newPage();
      pages.push(created);
      return created.page as unknown as Page;
    }),
    close: vi.fn(async () => {}),
  };
  const browser = {
    newContext: vi.fn(
      async (_options: Parameters<Browser["newContext"]>[0]) =>
        context as unknown as BrowserContext,
    ),
    close: vi.fn(async () => {}),
  };
  const launch = vi.fn(
    async (_options: ReturnType<typeof browserLaunchOptions>) => browser as unknown as Browser,
  );
  let proxyClosed = 0;
  const deps: HtmlPreviewBrowserDependencies = {
    executablePath: () => "/pinned/chromium",
    exists: vi.fn(async (_path) => true),
    launch,
    proxy: Effect.acquireRelease(Effect.succeed(12345), () =>
      Effect.sync(() => {
        proxyClosed += 1;
      }),
    ),
  };
  async function request(
    url: string,
    page = pages[0]!.page,
    mainFrame: boolean | "unavailable" = true,
    document = true,
  ) {
    const frame = mainFrame === true ? page.mainFrame() : { page: () => page };
    const route = {
      request: () => ({
        url: () => url,
        // Playwright throws here for a popup's first navigation, before its page exists.
        frame: () => {
          if (mainFrame === "unavailable")
            throw new Error("Frame for this request is not available");
          return frame;
        },
        isNavigationRequest: () => document,
      }),
      fulfill: vi.fn(async (_response: Parameters<Route["fulfill"]>[0]) => {}),
      abort: vi.fn(async (_code?: string) => {}),
      continue: vi.fn(async () => {}),
    };
    await handler!(route as unknown as Route);
    return route;
  }
  return {
    deps,
    browser,
    context,
    contextEvents,
    pages,
    launch,
    request,
    newPage,
    proxyClosed: () => proxyClosed,
    maxActivePages: () => maxActivePages,
  };
}

describe("HtmlPreviewBrowser", () => {
  it("uses the probed full Chromium channel with every hardening option and no sandbox fallback", () => {
    expect(browserLaunchOptions(1234)).toEqual({
      channel: "chromium",
      headless: true,
      chromiumSandbox: true,
      proxy: { server: "socks5://127.0.0.1:1234" },
      ignoreDefaultArgs: ["--disable-popup-blocking"],
      args: [
        "--block-new-web-contents",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--proxy-bypass-list=<-loopback>",
      ],
    });
  });

  it("keeps fake-origin resources and the main document locked down", () => {
    const policy = (url: string, mainFrame = true, document = true) =>
      requestPolicy({ url, mainFrame, document });
    expect(policy(PAGE_URL)).toBe("fulfill");
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "data:text/html,x",
      "javascript:alert(1)",
      "not a URL",
      `${PAGE_URL}?reload=1`,
      "http://pathway-page.localhost/other.html",
    ])
      expect(policy(url)).toBe("abort");
    expect(policy("https://example.com/redirect")).toBe("abort");
    expect(policy(PAGE_URL, false)).toBe("abort");
    expect(policy(PAGE_URL, true, false)).toBe("abort");
    expect(policy("https://example.com/frame", false)).toBe("continue");
    expect(policy("http://example.com/image.png", true, false)).toBe("continue");
    expect(policy("file:///etc/passwd", false)).toBe("abort");
  });

  it("bounds console ingestion and records an omission notice", () => {
    const console = consoleCapture();
    for (let index = 0; index < 100; index += 1) console.append("error", "x".repeat(1000));
    expect(console.messages()).toHaveLength(21);
    expect(
      console
        .messages()
        .slice(0, 20)
        .every((message) => message.text.length === 500),
    ).toBe(true);
    expect(console.messages()[20]).toEqual({
      level: "warning",
      text: "80 more console messages were omitted.",
    });
  });

  it.effect(
    "reports missing Chromium with the pinned installation command, without launching",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const browser = make({ ...f.deps, exists: async () => false });
        expect(yield* browser.available).toBe(false);
        const error = yield* browser
          .capture({ html: "<p>x</p>", width: 400, urlFragment: "" })
          .pipe(Effect.flip);
        expect(error.message).toContain("npx playwright@1.60.0 install chromium");
        expect(f.launch).not.toHaveBeenCalled();
      }),
  );

  it.effect("never retries a failed sandbox launch and closes the proxy", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.launch.mockRejectedValueOnce(new Error("No usable sandbox"));
      const error = yield* make(f.deps)
        .capture({ html: "<p>x</p>", width: 400, urlFragment: "" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("HtmlRenderBrowserError");
      expect(error.message).toContain("does not retry without it");
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.proxyClosed()).toBe(1);
    }),
  );

  it.effect(
    "serves exact UTF-8 memory bytes, blocks redirects/files/popups, and scopes resources",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const body = "<p>€ / 中文</p>";
        let inspected = false;
        const originalScreenshot = Buffer.from("PNG");
        f.context.newPage.mockImplementationOnce(async () => {
          const created = f.newPage();
          f.pages.push(created);
          created.page.screenshot.mockImplementationOnce(async () => {
            const memory = await f.request(PAGE_URL);
            expect(memory.fulfill).toHaveBeenCalledWith({
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: Buffer.from(body, "utf8"),
              headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
            });
            for (const [url, mainFrame, document] of [
              ["file:///tmp/secret.txt", false, true],
              ["https://example.com/redirect", true, true],
              ["http://pathway-page.localhost/favicon.ico", true, false],
              [PAGE_URL, false, true],
            ] as const)
              expect(
                (await f.request(url, created.page, mainFrame, document)).abort,
              ).toHaveBeenCalled();
            expect(
              (await f.request("https://example.com/frame", created.page, false, true)).continue,
            ).toHaveBeenCalled();
            const popup = f.newPage();
            expect((await f.request(PAGE_URL, popup.page)).abort).toHaveBeenCalled();
            await popup.page.close();
            inspected = true;
            return originalScreenshot;
          });
          return created.page as unknown as Page;
        });
        const result = yield* make(f.deps).capture({
          html: body,
          width: 400,
          urlFragment: "#theme",
        });
        expect(inspected).toBe(true);
        expect(result.png).toBe(originalScreenshot);
        expect(f.deps.exists).toHaveBeenCalledWith("/pinned/chromium");
        expect(f.context.route).toHaveBeenCalledTimes(1);
        expect(f.context.addInitScript).toHaveBeenCalledWith(
          "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;",
        );
        expect(f.browser.newContext).toHaveBeenCalledWith({
          serviceWorkers: "block",
          acceptDownloads: false,
          permissions: [],
          viewport: { width: 728, height: 800 },
          deviceScaleFactor: 1,
        });
        expect(f.pages[0]!.page.goto).toHaveBeenCalledWith(`${PAGE_URL}#theme`, {
          waitUntil: "load",
          timeout: 20_000,
        });
        expect(f.pages[0]!.page.close).toHaveBeenCalledOnce();
        expect(f.context.close).toHaveBeenCalledOnce();
        expect(f.browser.close).toHaveBeenCalledOnce();
        expect(f.proxyClosed()).toBe(1);
      }),
  );

  it.effect("refuses a request whose frame is unavailable instead of rejecting the route", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* make(f.deps).capture({ html: "x", width: 400, urlFragment: "" });
      // A rejected handler would surface as an unhandled rejection in the server.
      const route = yield* Effect.promise(() =>
        f.request("http://10.0.0.1/", f.pages[0]!.page, "unavailable"),
      );
      expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
      expect(route.continue).not.toHaveBeenCalled();
      expect(route.fulfill).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps installation advice out of failures that are not about Chromium", () =>
    Effect.gen(function* () {
      const f = fixture({ loadError: new Error("navigation failed") });
      const error = yield* make(f.deps)
        .capture({ html: "x", width: 400, urlFragment: "" })
        .pipe(Effect.flip);
      expect(error.message).toBe(
        "Chromium could not render the HTML page: the page could not load.",
      );
    }),
  );

  it.effect("caps PNG capture height at 4000 without losing the actual content height", () =>
    Effect.gen(function* () {
      const f = fixture({ height: 100_000 });
      const result = yield* make(f.deps).capture({ html: "<p>x</p>", width: 728, urlFragment: "" });
      expect(result.contentHeight).toBe(100_000);
      expect(result.capturedHeight).toBe(4000);
      expect(f.pages[0]!.page.screenshot).toHaveBeenCalledWith({
        type: "png",
        clip: { x: 0, y: 0, width: 728, height: 4000 },
        fullPage: true,
        timeout: 20_000,
      });
    }),
  );

  it.effect("closes every acquired resource on load failure", () =>
    Effect.gen(function* () {
      const f = fixture({ loadError: new Error("navigation failed") });
      yield* make(f.deps)
        .capture({ html: "<p>x</p>", width: 400, urlFragment: "" })
        .pipe(Effect.flip);
      expect(f.pages[0]!.page.close).toHaveBeenCalledOnce();
      expect(f.context.close).toHaveBeenCalledOnce();
      expect(f.browser.close).toHaveBeenCalledOnce();
      expect(f.proxyClosed()).toBe(1);
    }),
  );

  it.effect("closes main-frame blob/data navigations that bypass network routing", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.context.newPage.mockImplementationOnce(async () => {
        const created = f.newPage();
        f.pages.push(created);
        created.page.screenshot.mockImplementationOnce(async () => {
          const frame = created.page.mainFrame();
          frame.url = () => "blob:http://pathway-page.localhost/other";
          created.events.emit("framenavigated", frame);
          expect(created.page.close).toHaveBeenCalledOnce();
          return Buffer.from("PNG");
        });
        return created.page as unknown as Page;
      });
      const error = yield* make(f.deps)
        .capture({ html: "x", width: 400, urlFragment: "" })
        .pipe(Effect.flip);
      expect(error.reason).toContain("main frame left");
      expect(f.browser.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("closes the page, context, browser and proxy when interrupted during load", () =>
    Effect.gen(function* () {
      const entered = deferred();
      const gate = deferred<unknown>();
      const f = fixture({
        evaluate: () => {
          entered.resolve();
          return gate.promise;
        },
      });
      const fiber = yield* make(f.deps)
        .capture({ html: "<p>x</p>", width: 400, urlFragment: "" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(fiber);
      expect(f.pages[0]!.page.close).toHaveBeenCalledOnce();
      expect(f.context.close).toHaveBeenCalledOnce();
      expect(f.browser.close).toHaveBeenCalledOnce();
      expect(f.proxyClosed()).toBe(1);
      gate.resolve(true);
    }),
  );

  it.effect("closes a browser that finishes launching after cancellation", () =>
    Effect.gen(function* () {
      const f = fixture();
      const launched = deferred<Browser>();
      const entered = deferred();
      const closed = deferred();
      f.launch.mockImplementationOnce(() => {
        entered.resolve();
        return launched.promise;
      });
      f.browser.close.mockImplementationOnce(async () => {
        closed.resolve();
      });
      const fiber = yield* make(f.deps)
        .capture({ html: "x", width: 400, urlFragment: "" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(fiber);
      expect(f.proxyClosed()).toBe(1);
      launched.resolve(f.browser as unknown as Browser);
      yield* Effect.promise(() => closed.promise);
      expect(f.browser.close).toHaveBeenCalledOnce();
      expect(f.browser.newContext).not.toHaveBeenCalled();
    }),
  );

  it.effect("uses a fresh page per measurement and never more than three pages at once", () =>
    Effect.gen(function* () {
      const f = fixture({ height: 250 });
      const widths = [320, 375, 430, 520, 640, 728, 860, 1000, 1144];
      const result = yield* make(f.deps).measure({ html: "x", widths, urlFragment: "" });
      expect(result).toEqual(widths.map((width) => [width, 250]));
      expect(f.launch).toHaveBeenCalledOnce();
      expect(f.pages).toHaveLength(9);
      expect(f.maxActivePages()).toBeLessThanOrEqual(3);
      expect(f.pages.every(({ page }) => page.close.mock.calls.length === 1)).toBe(true);
      expect(f.context.close).toHaveBeenCalledOnce();
      expect(f.browser.close).toHaveBeenCalledOnce();
    }),
  );
});
