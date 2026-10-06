// @effect-diagnostics nodeBuiltinImport:off - plain local servers stand in for LAN services.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@spiritdevs/contracts";
import {
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_MEASURE_WIDTHS,
  htmlRenderTheme,
  htmlRenderThemeFragment,
} from "@spiritdevs/shared/htmlRender";
import { Pathway_CODE_DARK_THEME_COLORS } from "@spiritdevs/shared/themePalettes";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "./HtmlRender.ts";
import { HtmlPreviewBrowser, HtmlRenderBrowserError } from "./HtmlPreviewBrowser.ts";

const defaultBrowser = HtmlPreviewBrowser.of({
  available: Effect.succeed(false),
  capture: () => Effect.die("This unit test must not launch a browser."),
  measure: () => Effect.die("This unit test must not launch a browser."),
});
const htmlRenderLayer = (browser = defaultBrowser) =>
  HtmlRender.layer.pipe(
    Layer.provide(Layer.succeed(HtmlPreviewBrowser, browser)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-html-render-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const testLayer = htmlRenderLayer();

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const publishInput = {
  threadId: ThreadId.make("thread-html"),
  html: "<p>x</p>",
  title: " X ",
  height: 200,
};

const fakeService = (overrides: Partial<HtmlPreviewBrowser["Service"]>) =>
  HtmlPreviewBrowser.of({ ...defaultBrowser, ...overrides });

describe("HtmlRender", () => {
  it.effect("removes a partially written attachment when saving fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const render = yield* HtmlRender.make.pipe(
        Effect.provideService(HtmlPreviewBrowser, defaultBrowser),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (path, data) =>
            fs
              .writeFileString(path, data)
              .pipe(Effect.andThen(fs.readFileString(`${path}.not-found`)), Effect.asVoid),
        }),
      );
      expect((yield* render.publish(publishInput).pipe(Effect.flip))._tag).toBe(
        "HtmlRenderStoreError",
      );
      expect(yield* fs.readDirectory(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects partial PNG/GIF signatures instead of inlining renamed text", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const png = `${directory}/secret.png`;
      const gif = `${directory}/secret.gif`;
      yield* fs.writeFile(png, Buffer.from("\x89PNG secret", "latin1"));
      yield* fs.writeFileString(gif, "GIF8 secret");
      const render = yield* HtmlRender.HtmlRender;
      const error = yield* render.prepare(`<img src="${png}"><img src="${gif}">`).pipe(Effect.flip);
      expect(error._tag === "HtmlRenderImagesNotFoundError" && error.paths).toEqual([png, gif]);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("rejects oversized HTML before scanning or reading files", () =>
    Effect.gen(function* () {
      const render = yield* HtmlRender.HtmlRender;
      const error = yield* render
        .prepare("x".repeat(HtmlRender.MAX_HTML_CHARACTERS + 1))
        .pipe(Effect.flip);
      expect(error._tag).toBe("HtmlRenderHtmlTooLargeError");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses bounded reads, checks growth after stat, and reads duplicate references only once",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let reads = 0;
        const directory = yield* fs.makeTempDirectoryScoped();
        const image = `${directory}/image.png`;
        yield* fs.writeFile(image, PNG_BYTES);
        const fake = {
          ...fs,
          stream: (
            path: string,
            options?: { readonly bytesToRead?: FileSystem.SizeInput | undefined },
          ) => {
            reads += 1;
            expect(path).toBe(image);
            expect(options?.bytesToRead).toBe(HtmlRender.MAX_IMAGE_BYTES + 1);
            return Stream.succeed(PNG_BYTES);
          },
        };
        const render = yield* HtmlRender.make.pipe(
          Effect.provideService(FileSystem.FileSystem, fake),
          Effect.provideService(HtmlPreviewBrowser, defaultBrowser),
        );
        const result = yield* render.prepare(`<img src="${image}"><img src="${image}">`);
        expect(result.match(/data:image\/png;base64/g)).toHaveLength(2);
        expect(reads).toBe(1);

        const growing = yield* HtmlRender.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fake,
            stream: () => Stream.succeed(new Uint8Array(HtmlRender.MAX_IMAGE_BYTES + 1)),
          }),
          Effect.provideService(HtmlPreviewBrowser, defaultBrowser),
        );
        const error = yield* growing.prepare(`<img src="${image}">`).pipe(Effect.flip);
        expect(error._tag).toBe("HtmlRenderImageTooLargeError");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preflights per-image size and repeated base64 expansion before reading", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const image = `${directory}/big.png`;
      yield* fs.writeFile(image, PNG_BYTES);
      const info = yield* fs.stat(image);
      let reads = 0;
      const makeSized = (size: number) =>
        HtmlRender.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: () => Effect.succeed({ ...info, size: FileSystem.Size(size) }),
            stream: () => {
              reads += 1;
              return Stream.succeed(PNG_BYTES);
            },
          }),
          Effect.provideService(HtmlPreviewBrowser, defaultBrowser),
        );
      const oversized = yield* makeSized(HtmlRender.MAX_IMAGE_BYTES + 1);
      expect((yield* oversized.prepare(`<img src="${image}">`).pipe(Effect.flip))._tag).toBe(
        "HtmlRenderImageTooLargeError",
      );
      const repeated = yield* makeSized(HtmlRender.MAX_IMAGE_BYTES);
      expect(
        (yield* repeated.prepare(`<img src="${image}">`.repeat(2)).pipe(Effect.flip))._tag,
      ).toBe("HtmlRenderPageTooLargeError");
      expect(reads).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("checks final repeated expansion when a file grows within the per-image bound", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const image = `${directory}/grew.png`;
      yield* fs.writeFile(image, PNG_BYTES);
      const bytes = new Uint8Array(HtmlRender.MAX_IMAGE_BYTES);
      bytes.set(PNG_BYTES);
      const render = yield* HtmlRender.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stream: () => Stream.succeed(bytes),
        }),
        Effect.provideService(HtmlPreviewBrowser, defaultBrowser),
      );
      expect((yield* render.prepare(`<img src="${image}">`.repeat(2)).pipe(Effect.flip))._tag).toBe(
        "HtmlRenderPageTooLargeError",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("previews missing images, returning raw PNG separately from bounded metadata", () =>
    Effect.gen(function* () {
      let requestedWidth = 0;
      let requestedFragment = "";
      const browser = fakeService({
        capture: (input) => {
          requestedWidth = input.width;
          requestedFragment = input.urlFragment;
          expect(input.html).toContain("pathway-theme");
          return Effect.succeed({
            png: PNG_BYTES,
            contentHeight: 123,
            capturedHeight: 123,
            consoleMessages: [{ level: "error", text: "broken image" }],
          });
        },
      });
      const render = yield* HtmlRender.make.pipe(
        Effect.provideService(HtmlPreviewBrowser, browser),
      );
      const preview = yield* render.preview({
        html: '<img src="/nonexistent/pathway-image.png">',
        width: 2000,
        appearance: "light",
      });
      expect(requestedWidth).toBe(1600);
      expect(requestedFragment).toContain("pathway-theme=");
      expect(preview.png).toBe(PNG_BYTES);
      expect(preview.metadata).toEqual({
        width: 1600,
        contentHeight: 123,
        capturedHeight: 123,
        consoleMessages: [{ level: "error", text: "broken image" }],
        missingImages: ["/nonexistent/pathway-image.png"],
        screenshot: { mimeType: "image/png", width: 1600, height: 123 },
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("measures all widths in the standard dark theme and sorts the returned tuples", () =>
    Effect.gen(function* () {
      const render = yield* HtmlRender.make.pipe(
        Effect.provideService(
          HtmlPreviewBrowser,
          fakeService({
            available: Effect.succeed(true),
            measure: (input) => {
              expect(input.widths).toEqual(HTML_RENDER_MEASURE_WIDTHS);
              expect(input.urlFragment).toBe(
                htmlRenderThemeFragment(
                  htmlRenderTheme(
                    Pathway_CODE_DARK_THEME_COLORS,
                    "dark",
                    HTML_RENDER_MEASURE_FONTS,
                  ),
                ),
              );
              return Effect.succeed([
                [728, 240],
                [320, 410],
              ]);
            },
          }),
        ),
      );
      expect((yield* render.publish(publishInput)).heights).toEqual([
        [320, 410],
        [728, 240],
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes without heights when sandboxed measurement fails", () =>
    Effect.gen(function* () {
      const render = yield* HtmlRender.make.pipe(
        Effect.provideService(
          HtmlPreviewBrowser,
          fakeService({
            available: Effect.succeed(true),
            measure: () => Effect.fail(new HtmlRenderBrowserError({ reason: "No usable sandbox" })),
          }),
        ),
      );
      expect(yield* render.publish(publishInput)).not.toHaveProperty("heights");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("omits measurements at the six-second deadline and interrupts the measurement", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const render = yield* HtmlRender.make.pipe(
        Effect.provideService(
          HtmlPreviewBrowser,
          fakeService({
            available: Effect.succeed(true),
            measure: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(finished, undefined)),
              ),
          }),
        ),
      );
      const publishing = yield* render.publish(publishInput).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("6 seconds");
      expect(yield* Fiber.join(publishing)).not.toHaveProperty("heights");
      yield* Deferred.await(finished);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("limits concurrent browser jobs to two", () =>
    Effect.gen(function* () {
      const twoEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      const capture = Effect.sync(() => {
        active += 1;
        maximum = Math.max(maximum, active);
      }).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            active === 2 ? Deferred.succeed(twoEntered, undefined) : Effect.void,
          ),
        ),
        Effect.andThen(Deferred.await(release)),
        Effect.as({ png: PNG_BYTES, contentHeight: 10, capturedHeight: 10, consoleMessages: [] }),
        Effect.ensuring(
          Effect.sync(() => {
            active -= 1;
          }),
        ),
      );
      const render = yield* HtmlRender.make.pipe(
        Effect.provideService(HtmlPreviewBrowser, fakeService({ capture: () => capture })),
      );
      const jobs = yield* Effect.forEach([1, 2, 3], () =>
        render.preview({ html: "<p>x</p>" }).pipe(Effect.forkChild),
      );
      yield* Deferred.await(twoEntered);
      expect(active).toBe(2);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(jobs, Fiber.join);
      expect(maximum).toBe(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "discards a saved render after post-save authorization fails, and rejects arbitrary paths",
    () =>
      Effect.gen(function* () {
        const render = yield* HtmlRender.HtmlRender;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const reference = yield* render.publish(publishInput);
        yield* Effect.fail("authorization expired").pipe(
          Effect.onError(() => render.discardHtmlRender(reference).pipe(Effect.ignore)),
          Effect.flip,
        );
        expect(yield* fs.readDirectory(config.attachmentsDir)).toEqual([]);
        const error = yield* render
          .discardHtmlRender({ ...reference, attachmentId: "folder/other-html" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("HtmlRenderStoreError");
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect("inlines local images by absolute path and leaves URLs and relative paths alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pathway-html-images-",
      });
      const png = path.join(directory, "shot.png");
      const svg = path.join(directory, "logo.svg");
      yield* fileSystem.writeFile(png, PNG_BYTES);
      yield* fileSystem.writeFileString(svg, "<svg/>");
      const kept = [
        "https://example.com/a.png",
        "//cdn.example.com/b.png",
        "./c.png",
        "data:image/png;base64,AAAA",
      ];

      const prepared = yield* htmlRender.prepare(
        [
          "<!doctype html><html><head><title>Shots</title></head><body>",
          `<img src="${png}"><div style="background:url(${svg})"></div>`,
          `<script>const shots = ['${png}', \`${svg}\`];</script>`,
          ...kept.map((src) => `<img src="${src}">`),
          "</body></html>",
        ].join(""),
      );

      const pngUri = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
      const svgUri = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
      expect(prepared).toContain(`<img src="${pngUri}">`);
      expect(prepared).toContain(`url(${svgUri})`);
      expect(prepared).toContain(`['${pngUri}', \`${svgUri}\`]`);
      expect(prepared).not.toContain(directory);
      for (const src of kept) expect(prepared).toContain(`<img src="${src}">`);
      // The theme bootstrap opens the head, ahead of the page's own markup.
      expect(prepared.indexOf("<head>")).toBeLessThan(
        prepared.indexOf('<style id="pathway-theme">'),
      );
      expect(prepared.indexOf('<style id="pathway-theme">')).toBeLessThan(
        prepared.indexOf("<title>"),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("never touches paths that Windows reads as UNC shares", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const touched: Array<string> = [];
      const render = yield* HtmlRender.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (path) => {
            touched.push(path);
            return fs.stat(path);
          },
        }),
        Effect.provideService(HtmlPreviewBrowser, defaultBrowser),
      );
      // `/\host\share` resolves to `\\?\UNC\host\share` on Windows, an SMB connection.
      const share = String.raw`/\evil.example\share\x.png`;
      const escaped = share.replaceAll("\\", "\\\\");
      const prepared = yield* render.prepare(
        `<img src="${share}"><div style="background:url(${share})"></div><script>const x = '${escaped}';</script>`,
      );
      expect(touched).toEqual([]);
      expect(prepared).toContain(`<img src="${share}">`);
      expect(prepared).toContain(`'${escaped}'`);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("inlines an SVG behind processing instructions and a doctype subset", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pathway-html-images-",
      });
      const svg = path.join(directory, "styled.svg");
      const source = [
        '<?xml version="1.0"?>',
        '<?xml-stylesheet href="theme.css"?>',
        '<!DOCTYPE svg [ <!ENTITY fill "red"> ]>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
      ].join("\n");
      yield* fileSystem.writeFileString(svg, source);

      const prepared = yield* htmlRender.prepare(`<img src="${svg}">`);

      expect(prepared).toContain(
        `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("lists every local image it cannot read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pathway-html-images-",
      });
      const folder = path.join(directory, "folder.png");
      yield* fileSystem.makeDirectory(folder);
      const missing = path.join(directory, "missing.jpg");
      // Named like an image, but a symlink or renamed file must not carry other data.
      const secret = path.join(directory, "secret.png");
      yield* fileSystem.writeFileString(secret, "API_KEY=abc123");
      const report = path.join(directory, "report.svg");
      yield* fileSystem.writeFileString(report, "<!doctype html><body><svg></svg>API_KEY=abc123");
      // An <svg> inside a quoted entity, and a prolog shaped to stall a backtracking matcher.
      const config = path.join(directory, "config.svg");
      yield* fileSystem.writeFileString(
        config,
        '<!DOCTYPE config [<!ENTITY a "a"><!ENTITY b "]><svg/>">]><config>API_KEY=abc123</config>',
      );
      const stalling = path.join(directory, "stalling.svg");
      yield* fileSystem.writeFileString(stalling, `${"<?p?>".repeat(40)}<config><svg/></config>`);
      const unclosed = path.join(directory, "unclosed.svg");
      yield* fileSystem.writeFileString(unclosed, '<!DOCTYPE svg [<!ENTITY a "x><svg/>');
      // Roots named SVG or svgé are other elements.
      const upper = path.join(directory, "upper.svg");
      yield* fileSystem.writeFileString(upper, "<SVG/>API_KEY=abc123");
      const longer = path.join(directory, "longer.svg");
      yield* fileSystem.writeFileString(longer, "<svg\u00e9/>API_KEY=abc123");

      const error = yield* htmlRender
        .prepare(
          `<img src="${missing}"><img src='${folder}'><img src="C:\\nope\\shot.webp"><img src="${secret}"><img src="${report}"><img src="${config}"><img src="${stalling}"><img src="${unclosed}"><img src="${upper}"><img src="${longer}">`,
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("HtmlRenderImagesNotFoundError");
      expect(error._tag === "HtmlRenderImagesNotFoundError" && error.paths).toEqual([
        missing,
        folder,
        "C:\\nope\\shot.webp",
        secret,
        report,
        config,
        stalling,
        unclosed,
        upper,
        longer,
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes the prepared page as an html thread attachment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const htmlRender = yield* HtmlRender.HtmlRender;

      const reference = yield* htmlRender.publish({
        threadId: ThreadId.make("thread-html-render"),
        html: "<p>Quarterly revenue</p>",
        title: "  Revenue  ",
        height: 9_000,
      });

      // Without an installed preview browser the page publishes unmeasured.
      expect(reference).toEqual({
        attachmentId: expect.any(String),
        title: "Revenue",
        height: 2_000,
      });
      const stored = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: reference.attachmentId,
      });
      expect(stored?.endsWith(".html")).toBe(true);
      const html = yield* fileSystem.readFileString(stored ?? "");
      expect(html).toContain('<style id="pathway-theme">');
      expect(html).toContain("<p>Quarterly revenue</p>");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes the page when publishing is interrupted", () =>
    Effect.gen(function* () {
      const measuring = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const htmlRender = yield* HtmlRender.HtmlRender;
        const storedPages = fileSystem
          .readDirectory(config.attachmentsDir, { recursive: true })
          .pipe(Effect.map((names) => names.filter((name) => name.endsWith(".html"))));

        const publishing = yield* htmlRender
          .publish({
            threadId: ThreadId.make("thread-html-cancel"),
            html: "<p>x</p>",
            title: "X",
            height: 200,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(measuring);
        expect(yield* storedPages).toHaveLength(1);
        yield* Fiber.interrupt(publishing);
        expect(yield* storedPages).toEqual([]);
      }).pipe(
        Effect.provide(
          htmlRenderLayer(
            HtmlPreviewBrowser.of({
              ...defaultBrowser,
              available: Effect.succeed(true),
              measure: () =>
                Deferred.succeed(measuring, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        ),
      );
    }),
  );
});
