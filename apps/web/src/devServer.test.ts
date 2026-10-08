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
  return { port, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// Sends `path` byte for byte (fetch would resolve dot segments first) and resolves with the status.
function send(port: number, path: string, upgrade = false) {
  return new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request({
      host: "127.0.0.1",
      port,
      path,
      agent: false,
      method: upgrade ? "GET" : "POST",
      headers: upgrade
        ? {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          }
        : {},
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode!);
    });
    request.on("response", (response) => {
      response.resume().on("end", () => resolve(response.statusCode!));
    });
    request.on("error", reject);
    request.end();
  });
}

it("proxies only the engine's client routes and never serves the local deploy key", async () => {
  const seen: string[] = [];
  const engine = NodeHttp.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.end("engine");
  });
  engine.on("upgrade", (request, socket) => {
    seen.push(`UPGRADE ${request.url}`);
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
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
    for (const path of ["/cyndrbase/api/query", "/cyndrbase/api/mutation", "/cyndrbase/api/action"])
      expect(await send(guarded.port, path)).toBe(200);
    expect(await send(guarded.port, "/cyndrbase/.files/download/kg2a7/q-9_Z")).toBe(200);
    expect(await send(guarded.port, "/cyndrbase/api/1.43.0/sync", true)).toBe(101);
    const admin = "cyndrbase.platform.v1.EnvironmentService/SetEnvVar";
    for (const path of [
      "/cyndrbase/cyndrbase.platform.v1.DeployService/ApplyDeploy",
      `/cyndrbase/${admin}`,
      "/cyndrbase/bundles/abc",
      "/cyndrbase/cyndrbase.console.v1.DataBrowserService/ListTables",
      "/cyndrbase/cyndrbase.files.v1.FilesIngestService/CommitUpload",
      "/cyndrbase/api/run/smoke/seed",
      "/cyndrbase/api/queryx",
      `/cyndrbase/.files/download/../../${admin}`,
      `/cyndrbase/.files/download/%2e%2e/%2E%2E/${admin}`,
      `/cyndrbase/.files/download/a%2f..%2f..%2f${admin.replace("/", "%2f")}`,
      "/cyndrbase//api/run/smoke/seed",
      "/cyndrbase/.files/download//kg2a7/q-9_Z",
    ]) {
      expect(await send(guarded.port, path)).toBe(404);
      expect(await send(guarded.port, path, true)).toBe(404);
    }
    expect(await send(guarded.port, "/cyndrbase/api/1.43.0/sync/../../run/smoke/seed", true)).toBe(
      404,
    );
    expect(seen).toEqual([
      "POST /api/query",
      "POST /api/mutation",
      "POST /api/action",
      "POST /.files/download/kg2a7/q-9_Z",
      "UPGRADE /api/1.43.0/sync",
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
