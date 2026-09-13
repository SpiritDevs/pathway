import { ThreadId } from "@spiritdevs/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as PathwayProjectFileLoader from "../project/PathwayProjectFileLoader.ts";
import { assetRouteLayer } from "../http.ts";
import { issueAssetUrl } from "./AssetAccess.ts";

const config = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "pathway-asset-range-",
});
const dependencies = Layer.mergeAll(
  config,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(PathwayProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(config)),
  NodeHttpPlatform.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("serves signed video ranges and rejects altered access", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(settings.attachmentsDir, { recursive: true });
    const id = "range-verification";
    yield* fs.writeFile(
      path.join(settings.attachmentsDir, `${id}.mp4`),
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
    const asset = yield* issueAssetUrl({
      resource: { _tag: "attachment", attachmentId: id, mimeType: "video/mp4" },
    });
    const context = yield* Effect.context<Layer.Success<typeof dependencies>>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          assetRouteLayer.pipe(Layer.provideMerge(Layer.succeedContext(context))),
          { disableLogger: true },
        ),
      ),
      (server) => Effect.promise(() => server.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(
        new Request(`http://localhost${asset.relativeUrl}`, { headers: { range: "bytes=2-5" } }),
      ),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-type")).toContain("video/mp4");
    expect([...new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))]).toEqual([
      2, 3, 4, 5,
    ]);
    const invalid = yield* Effect.promise(() =>
      server.handler(
        new Request(`http://localhost${asset.relativeUrl}`, { headers: { range: "bytes=10-" } }),
      ),
    );
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
    const altered = yield* Effect.promise(() =>
      server.handler(
        new Request(
          `http://localhost${asset.relativeUrl.replace("/api/assets/", "/api/assets/altered")}`,
          { headers: { range: "bytes=0-1" } },
        ),
      ),
    );
    expect(altered.status).toBe(404);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("streams workspace video previews with seeking and exact file access", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(settings.attachmentsDir, { recursive: true });
    const id = "range-verification";
    yield* fs.writeFile(
      path.join(settings.attachmentsDir, `${id}.mp4`),
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
    const asset = yield* issueAssetUrl({
      resource: {
        _tag: "workspace-file",
        threadId: ThreadId.make("video-thread"),
        path: `${id}.mp4`,
      },
      workspaceRoot: settings.attachmentsDir,
    });
    const context = yield* Effect.context<Layer.Success<typeof dependencies>>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          assetRouteLayer.pipe(Layer.provideMerge(Layer.succeedContext(context))),
          { disableLogger: true },
        ),
      ),
      (server) => Effect.promise(() => server.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(
        new Request(`http://localhost${asset.relativeUrl}`, { headers: { range: "bytes=2-5" } }),
      ),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-type")).toContain("video/mp4");
    expect([...new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))]).toEqual([
      2, 3, 4, 5,
    ]);
    const invalid = yield* Effect.promise(() =>
      server.handler(
        new Request(`http://localhost${asset.relativeUrl}`, { headers: { range: "bytes=10-" } }),
      ),
    );
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
    const altered = yield* Effect.promise(() =>
      server.handler(
        new Request(
          `http://localhost${asset.relativeUrl.replace("/api/assets/", "/api/assets/altered")}`,
          { headers: { range: "bytes=0-1" } },
        ),
      ),
    );
    expect(altered.status).toBe(404);
  }).pipe(Effect.provide(dependencies)),
);
