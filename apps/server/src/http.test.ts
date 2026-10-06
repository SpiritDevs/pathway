import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { AssetResource } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import { issueAssetUrl } from "./assets/AssetAccess.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import {
  assetResponseHeaders,
  assetRouteLayer,
  isLoopbackHostname,
  resolveDevRedirectUrl,
  staticFileCacheControl,
} from "./http.ts";
import * as PathwayProjectFileLoader from "./project/PathwayProjectFileLoader.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

const INLINE_HTML_HEADERS = {
  "Cache-Control": "private, max-age=3600",
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("declares utf-8 for HTML assets so non-ASCII content renders correctly", () => {
    expect(assetResponseHeaders("/workspace/page.html")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    expect(assetResponseHeaders("/workspace/PAGE.HTM")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
  });

  it("forces generic attachments to download without active document MIME types", () => {
    expect(
      assetResponseHeaders("/attachments/report.html", {
        download: true,
        fileName: 'quarterly "report".html',
        mimeType: "text/html",
      }),
    ).toMatchObject({
      "Content-Disposition": 'attachment; filename="quarterly _report_.html"',
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
  });
});

describe("inline HTML attachments", () => {
  it("get exactly the sandboxed document headers", () => {
    expect(assetResponseHeaders("/attachments/page-html.html", { inlineHtml: true })).toEqual(
      INLINE_HTML_HEADERS,
    );
  });

  it("leave workspace HTML previews unsandboxed", () => {
    expect(assetResponseHeaders("/workspace/page.html")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
  });

  const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "pathway-http-inline-html-",
  });
  const routeDependencies = Layer.mergeAll(
    configLayer,
    WorkspacePaths.layer,
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(PathwayProjectFileLoader.layer),
    ),
    ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
    NodeHttpPlatform.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

  it.effect("serve full and range responses with the same headers, and downloads on request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001-html";
      const page = "<h1>Chart</h1>";
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(path.join(config.attachmentsDir, `${attachmentId}.html`), page);
      const context = yield* Effect.context<Layer.Success<typeof routeDependencies>>();
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            assetRouteLayer.pipe(Layer.provideMerge(Layer.succeedContext(context))),
            { disableLogger: true },
          ),
        ),
        (server) => Effect.promise(() => server.dispose()),
      );
      const request = (resource: AssetResource, headers?: Record<string, string>) =>
        Effect.gen(function* () {
          const { relativeUrl } = yield* issueAssetUrl({ resource });
          return yield* Effect.promise(() =>
            server.handler(new Request(`http://localhost${relativeUrl}`, { headers })),
          );
        });
      const inline = {
        _tag: "attachment",
        attachmentId,
        fileName: "Chart.html",
        mimeType: "text/html",
        disposition: "inline",
      } as const;
      const securityHeaders = (response: Response) =>
        Object.fromEntries(
          Object.keys(INLINE_HTML_HEADERS).map((name) => [name, response.headers.get(name)]),
        );
      // The document policy plus file transport headers, and nothing else.
      const headerNames = (response: Response) => [...response.headers.keys()].toSorted();
      const transportHeaders = ["accept-ranges", "content-length", "etag", "last-modified"];
      const expectedNames = [
        ...Object.keys(INLINE_HTML_HEADERS).map((name) => name.toLowerCase()),
        ...transportHeaders,
      ];

      const full = yield* request(inline);
      expect(full.status).toBe(200);
      expect(securityHeaders(full)).toEqual(INLINE_HTML_HEADERS);
      expect(headerNames(full)).toEqual(expectedNames.toSorted());
      expect(yield* Effect.promise(() => full.text())).toBe(page);

      const range = yield* request(inline, { range: "bytes=1-2" });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-range")).toBe(`bytes 1-2/${page.length}`);
      expect(securityHeaders(range)).toEqual(INLINE_HTML_HEADERS);
      expect(headerNames(range)).toEqual([...expectedNames, "content-range"].toSorted());
      expect(yield* Effect.promise(() => range.text())).toBe("h1");

      const download = yield* request({ ...inline, disposition: "attachment" });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toBe('attachment; filename="Chart.html"');
      expect(download.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.has("referrer-policy")).toBe(false);
    }).pipe(Effect.provide(routeDependencies)),
  );
});

describe("staticFileCacheControl", () => {
  it("caches content-hashed build assets for good", () => {
    expect(staticFileCacheControl("assets/index-DQ_IL-pM.js")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("revalidates the document and unhashed public files", () => {
    expect(staticFileCacheControl("index.html")).toBe("no-cache");
    expect(staticFileCacheControl("manifest.webmanifest")).toBe("no-cache");
    expect(staticFileCacheControl("mockServiceWorker.js")).toBe("no-cache");
  });
});
