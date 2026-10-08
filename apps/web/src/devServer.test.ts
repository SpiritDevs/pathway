// @effect-diagnostics nodeBuiltinImport:off - Starts real HTTP servers to check Vite's proxy and file serving.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createServer, type InlineConfig } from "vite";
import { expect, it } from "vite-plus/test";

import { DEV_FS_DENY, localCyndrbaseProxy } from "./devServer";

async function serve(config: InlineConfig) {
  const server = await createServer({ configFile: false, logLevel: "silent", ...config });
  await server.listen();
  const { port } = server.httpServer!.address() as NodeNet.AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

it("proxies only the engine's client routes and never serves the local deploy key", async () => {
  const seen: string[] = [];
  const engine = NodeHttp.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.end("engine");
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${(engine.address() as NodeNet.AddressInfo).port}`;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-dev-server-"));
  const key = NodePath.join(root, ".pathway/cyndrbase/deploy-key");
  await NodeFSP.mkdir(NodePath.dirname(key), { recursive: true });
  await NodeFSP.writeFile(key, "secret");
  const server = { host: "127.0.0.1", port: 0, fs: { allow: [root] } };
  const guarded = await serve({
    root,
    server: {
      ...server,
      proxy: localCyndrbaseProxy(target),
      fs: { allow: [root], deny: DEV_FS_DENY },
    },
  });
  const unguarded = await serve({ root, server });
  try {
    const request = (path: string, method = "POST") =>
      fetch(`${guarded.origin}${path}`, { method, ...(method === "GET" ? {} : { body: "{}" }) });
    for (const path of [
      "/cyndrbase/api/1.43.0/sync",
      "/cyndrbase/api/query",
      "/cyndrbase/api/mutation",
      "/cyndrbase/api/action",
    ])
      expect(await (await request(path)).text()).toBe("engine");
    expect(await (await request("/cyndrbase/.files/download/id/signature", "GET")).text()).toBe(
      "engine",
    );
    for (const path of [
      "/cyndrbase/cyndrbase.platform.v1.DeployService/ApplyDeploy",
      "/cyndrbase/cyndrbase.platform.v1.EnvironmentService/SetEnvVar",
      "/cyndrbase/bundles/abc",
      "/cyndrbase/cyndrbase.console.v1.DataBrowserService/ListTables",
      "/cyndrbase/cyndrbase.files.v1.FilesIngestService/CommitUpload",
      "/cyndrbase/api/run/smoke/seed",
      "/cyndrbase/api/queryx",
    ])
      expect(await (await request(path)).text()).not.toBe("engine");
    expect(seen).toEqual([
      "POST /api/1.43.0/sync",
      "POST /api/query",
      "POST /api/mutation",
      "POST /api/action",
      "GET /.files/download/id/signature",
    ]);
    expect((await fetch(`${guarded.origin}/@fs${key}`)).status).toBe(403);
    // Vite's own defaults would serve it: the deny list is what protects the key.
    expect(await (await fetch(`${unguarded.origin}/@fs${key}`)).text()).toContain("secret");
  } finally {
    await guarded.close();
    await unguarded.close();
    engine.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
