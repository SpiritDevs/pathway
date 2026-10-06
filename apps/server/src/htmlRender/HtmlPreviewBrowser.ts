// @effect-diagnostics nodeBuiltinImport:off - Playwright and SOCKS sockets are the browser adapter boundary.
import * as NodeFSP from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import type { HtmlPreviewMetadata } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { publicProxy } from "./publicProxy.ts";

export class HtmlRenderBrowserError extends Schema.TaggedErrorClass<HtmlRenderBrowserError>()(
  "HtmlRenderBrowserError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Chromium could not render the HTML page: ${this.reason}.`;
  }
}

const INSTALL_ADVICE =
  "Install Chromium on this environment with npx playwright@1.60.0 install chromium (Linux may also need install-deps chromium). Chromium must be able to run its OS sandbox; Pathway does not retry without it";

export type ConsoleMessage = HtmlPreviewMetadata["consoleMessages"][number];
export interface HtmlCapture {
  readonly png: Uint8Array;
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<ConsoleMessage>;
}
export interface HtmlBrowserInput {
  readonly html: string;
  readonly urlFragment: string;
}

export class HtmlPreviewBrowser extends Context.Service<
  HtmlPreviewBrowser,
  {
    readonly available: Effect.Effect<boolean>;
    readonly capture: (
      input: HtmlBrowserInput & { readonly width: number },
    ) => Effect.Effect<HtmlCapture, HtmlRenderBrowserError>;
    readonly measure: (
      input: HtmlBrowserInput & { readonly widths: ReadonlyArray<number> },
    ) => Effect.Effect<Array<[number, number]>, HtmlRenderBrowserError>;
  }
>()("@spiritdevs/pathway/htmlRender/HtmlPreviewBrowser") {}

export const PAGE_ORIGIN = "http://pathway-page.localhost";
export const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
const VIEWPORT_HEIGHT = 800;
const MAX_CAPTURE_HEIGHT = 4000;
const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
const MEASURE_CONCURRENCY = 3;

export const browserLaunchOptions = (proxyPort: number) => ({
  channel: "chromium",
  headless: true,
  chromiumSandbox: true,
  proxy: { server: `socks5://127.0.0.1:${proxyPort}` },
  ignoreDefaultArgs: ["--disable-popup-blocking"],
  args: [
    "--block-new-web-contents",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--proxy-bypass-list=<-loopback>",
  ],
});

/** One context route owns interception, including nested frames and popup requests.
 * Chromium's web-origin file restrictions and the proxy also cover requests that
 * do not reach routing. No CDP Fetch handler competes with Playwright's handler.
 */
export const requestPolicy = (input: {
  readonly url: string;
  readonly document: boolean;
  readonly mainFrame: boolean;
}) => {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return "abort" as const;
  }
  if (url.origin === PAGE_ORIGIN) {
    return url.href === PAGE_URL && input.document && input.mainFrame
      ? ("fulfill" as const)
      : ("abort" as const);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "abort" as const;
  if (input.document && input.mainFrame) return "abort" as const;
  return "continue" as const;
};

/** Bounded at ingestion, so a logging loop cannot retain unbounded strings. */
export const consoleCapture = () => {
  const messages: Array<ConsoleMessage> = [];
  let omitted = 0;
  return {
    append: (level: ConsoleMessage["level"], text: string) => {
      if (messages.length < MAX_CONSOLE_MESSAGES)
        messages.push({ level, text: text.slice(0, MAX_CONSOLE_TEXT_CHARS) });
      else omitted += 1;
    },
    messages: (): Array<ConsoleMessage> =>
      omitted === 0
        ? [...messages]
        : [
            ...messages,
            { level: "warning", text: `${omitted} more console messages were omitted.` },
          ],
  };
};

const WEBRTC_INIT_SCRIPT =
  "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;";
// String expressions execute in Chromium; the server project has no DOM types.
const SETTLE_EXPRESSION =
  "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
const MEASURE_EXPRESSION =
  "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";
const decodeHeight = Schema.decodeUnknownEffect(Schema.Finite);
const isMemoryPage = (url: string) => url.split("#", 1)[0] === PAGE_URL;

export interface HtmlPreviewBrowserDependencies {
  readonly executablePath: () => string;
  readonly exists: (path: string) => Promise<boolean>;
  readonly launch: (options: ReturnType<typeof browserLaunchOptions>) => Promise<Browser>;
  readonly proxy: Effect.Effect<number, Error, Scope.Scope>;
}
const dependencies: HtmlPreviewBrowserDependencies = {
  executablePath: () => chromium.executablePath(),
  exists: (path) =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  launch: (options) => chromium.launch(options),
  proxy: publicProxy,
};

const attempt = <A>(reason: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new HtmlRenderBrowserError({ reason, cause }),
  });
const close = (run: () => Promise<unknown>) => Effect.promise(run).pipe(Effect.ignoreCause);

// Playwright acquisitions cannot be cancelled. Close a result that arrives after
// interruption instead of letting it escape the scope or extending the deadline.
const acquire = <A>(
  reason: string,
  run: () => Promise<A>,
  release: (resource: A) => Promise<unknown>,
) =>
  Effect.acquireRelease(
    Effect.interruptible(
      Effect.tryPromise({
        try: async (signal) => {
          const resource = await run();
          if (signal.aborted) {
            await release(resource);
            throw new Error("The browser job was interrupted during acquisition.");
          }
          return resource;
        },
        catch: (cause) => new HtmlRenderBrowserError({ reason, cause }),
      }),
    ),
    (resource) => close(() => release(resource)),
  );

export const make = (deps: HtmlPreviewBrowserDependencies = dependencies) => {
  const available = attempt("the pinned Chromium executable could not be checked", () =>
    deps.exists(deps.executablePath()),
  ).pipe(Effect.orElseSucceed(() => false));

  const open = Effect.fn("HtmlPreviewBrowser.open")(function* (html: string) {
    if (!(yield* available))
      return yield* new HtmlRenderBrowserError({
        reason: `the pinned Chromium executable is missing. ${INSTALL_ADVICE}`,
      });
    const port = yield* deps.proxy.pipe(
      Effect.mapError(
        (cause) =>
          new HtmlRenderBrowserError({ reason: "the public-only proxy could not start", cause }),
      ),
    );
    const browser = yield* acquire(
      `the sandboxed browser could not start. ${INSTALL_ADVICE}`,
      () => deps.launch(browserLaunchOptions(port)),
      (browser) => browser.close(),
    );
    const context = yield* acquire(
      "an isolated context could not start",
      () =>
        browser.newContext({
          serviceWorkers: "block",
          acceptDownloads: false,
          permissions: [],
          viewport: { width: 728, height: VIEWPORT_HEIGHT },
          deviceScaleFactor: 1,
        }),
      (context) => context.close(),
    );
    const pages = new Set<Page>();
    yield* attempt("the page guards could not be installed", async () => {
      context.on("page", (page) => {
        page.on("dialog", (dialog) => {
          void dialog.dismiss().catch(() => {});
        });
        page.on("download", (download) => {
          void download.cancel().catch(() => {});
        });
        // Launch flags prevent popup scripts; this is a second guard for unexpected targets.
        void page
          .opener()
          .then((opener) => {
            if (opener && !page.isClosed()) return page.close();
          })
          .catch(() => {});
      });
      await context.addInitScript(WEBRTC_INIT_SCRIPT);
      const body = Buffer.from(html, "utf8");
      const handle = async (route: Route) => {
        const request = route.request();
        const frame = request.frame();
        const mainFrame = frame === frame.page().mainFrame();
        const policy = requestPolicy({
          url: request.url(),
          document: request.isNavigationRequest(),
          mainFrame,
        });
        // Only pages created by this job can load the memory document, never popup targets.
        if (policy === "fulfill" && pages.has(frame.page())) {
          await route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body,
            headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
          });
        } else if (policy === "continue") await route.continue();
        else await route.abort("blockedbyclient");
      };
      // Playwright rethrows a rejected route handler as an unhandled rejection,
      // which would stop the server. `request.frame()` throws for a popup's first
      // navigation (Playwright's evaluate and screenshot grant user activation),
      // so a request the handler cannot classify is refused instead.
      await context.route("**/*", (route: Route) =>
        handle(route).catch(() => route.abort("blockedbyclient").catch(() => {})),
      );
    });
    return { context, pages };
  });

  const load = Effect.fn("HtmlPreviewBrowser.load")(function* (
    runtime: { context: BrowserContext; pages: Set<Page> },
    width: number,
    urlFragment: string,
  ) {
    const page = yield* acquire(
      "a page could not start",
      () => runtime.context.newPage(),
      (page) => {
        runtime.pages.delete(page);
        return page.close();
      },
    );
    runtime.pages.add(page);
    // Blob/data/about navigations may not issue a routable network request.
    // Fail the job rather than capture another main document in those cases.
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && !isMemoryPage(frame.url())) {
        void page.close().catch(() => {});
      }
    });
    const console = consoleCapture();
    page.on("console", (message) => {
      const level = message.type();
      console.append(
        level === "error" || level === "assert"
          ? "error"
          : level === "warning"
            ? "warning"
            : level === "info"
              ? "info"
              : "log",
        message.text(),
      );
    });
    page.on("pageerror", (error) => console.append("error", error.message));
    yield* attempt("the page could not load", async () => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await page.goto(`${PAGE_URL}${urlFragment}`, { waitUntil: "load", timeout: 20_000 });
      await page.evaluate(SETTLE_EXPRESSION);
    });
    const measured: unknown = yield* attempt("the page could not be measured", () =>
      page.evaluate(MEASURE_EXPRESSION),
    );
    const height = yield* decodeHeight(measured).pipe(
      Effect.mapError(
        (cause) =>
          new HtmlRenderBrowserError({ reason: "the page returned an invalid height", cause }),
      ),
    );
    if (page.isClosed() || !isMemoryPage(page.url())) {
      return yield* new HtmlRenderBrowserError({ reason: "the main frame left the memory page" });
    }
    return { page, contentHeight: Math.max(1, Math.ceil(height)), console };
  });

  const capture = Effect.fn("HtmlPreviewBrowser.capture")(
    function* (input: HtmlBrowserInput & { readonly width: number }) {
      const runtime = yield* open(input.html);
      const { page, contentHeight, console } = yield* load(runtime, input.width, input.urlFragment);
      const capturedHeight = Math.min(contentHeight, MAX_CAPTURE_HEIGHT);
      const png = yield* attempt("the PNG could not be captured", () =>
        page.screenshot({
          type: "png",
          clip: { x: 0, y: 0, width: input.width, height: capturedHeight },
          fullPage: true,
          timeout: 20_000,
        }),
      );
      if (page.isClosed() || !isMemoryPage(page.url())) {
        return yield* new HtmlRenderBrowserError({
          reason: "the main frame left the memory page during capture",
        });
      }
      return {
        png,
        contentHeight,
        capturedHeight,
        consoleMessages: console.messages(),
      } satisfies HtmlCapture;
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () =>
        Effect.fail(
          new HtmlRenderBrowserError({ reason: "the page did not finish within 20 seconds" }),
        ),
    }),
  );

  const measure = Effect.fn("HtmlPreviewBrowser.measure")(function* (
    input: HtmlBrowserInput & { readonly widths: ReadonlyArray<number> },
  ) {
    const runtime = yield* open(input.html);
    return yield* Effect.forEach(
      input.widths,
      (width) =>
        load(runtime, width, input.urlFragment).pipe(
          Effect.map(({ contentHeight }) => [width, contentHeight] as [number, number]),
          Effect.scoped,
        ),
      { concurrency: MEASURE_CONCURRENCY },
    );
  }, Effect.scoped);

  return HtmlPreviewBrowser.of({ available, capture, measure });
};

export const layer = Layer.sync(HtmlPreviewBrowser, make);
