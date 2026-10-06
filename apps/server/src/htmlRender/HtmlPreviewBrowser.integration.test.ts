// @effect-diagnostics nodeBuiltinImport:off - isolated listeners and files are security fixtures.
import * as NodeHttp from "node:http";
import * as NodeDgram from "node:dgram";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as HtmlRender from "./HtmlRender.ts";
import * as HtmlPreviewBrowser from "./HtmlPreviewBrowser.ts";

// Intentionally opt-in. The unit command excludes this file. Do not launch Chromium
// without explicit user authorization, even when the binary is already installed.
const enabled = process.env.PATHWAY_HTML_RENDER_BROWSER_TESTS === "1";
const testLayer = HtmlRender.layer.pipe(
  Layer.provide(HtmlPreviewBrowser.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-html-security-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe.skipIf(!enabled)("HtmlPreviewBrowser real Chromium security", () => {
  it.live(
    "never reads a sentinel local file through script/frame/fetch/popup or renders its bytes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-html-sentinel-" });
        const sentinel = "PATHWAY_LOCAL_SENTINEL_7c92d128";
        const file = `${directory}/secret.js`;
        yield* fs.writeFileString(
          file,
          `window.secret = '${sentinel}'; document.getElementById('result').textContent = window.secret; console.log(window.secret);`,
        );
        const render = yield* HtmlRender.HtmlRender;
        const html = (url: string) =>
          [
            '<style>html,body{margin:0}#result{height:120px;font:16px monospace}</style><div id="result">safe</div>',
            `<script src="${url}"></script><iframe src="${url}" hidden></iframe>`,
            `<script>fetch(${JSON.stringify(url)}).then(r=>r.text()).then(console.log).catch(()=>{});`,
            `window.open(${JSON.stringify(url)}); console.log('secret:', window.secret ?? 'none');</script>`,
          ].join("");
        const result = yield* render.preview({
          html: html(NodeURL.pathToFileURL(file).href),
          width: 400,
        });
        const baseline = yield* render.preview({
          html: html(NodeURL.pathToFileURL(`${directory}/missing.js`).href),
          width: 400,
        });
        expect(result.metadata.consoleMessages.map(({ text }) => text)).toContain("secret: none");
        expect(result.metadata.consoleMessages.map(({ text }) => text).join(" ")).not.toContain(
          sentinel,
        );
        // A leaked script would replace visible content as well as logging the sentinel.
        expect(Buffer.from(result.png)).toEqual(Buffer.from(baseline.png));
      }).pipe(Effect.provide(testLayer)),
    30_000,
  );

  it.live(
    "sends no private HTTP/WebSocket/STUN traffic and blocks popup and WebRTC constructors",
    () =>
      Effect.gen(function* () {
        const connections: Array<string> = [];
        const requests: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server, Error>((resume) => {
            const server = NodeHttp.createServer((request, response) => {
              requests.push(request.url ?? "");
              if (request.url === "/redirect") {
                response.writeHead(302, { Location: "/secret" });
                response.end();
              } else response.end("PRIVATE_SENTINEL");
            });
            server.on("connection", () => connections.push("tcp"));
            server.on("error", (error) => resume(Effect.fail(error)));
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.closeAllConnections();
              server.close(() => resume(Effect.void));
            }),
        );
        const datagrams: Array<string> = [];
        const udp = yield* Effect.acquireRelease(
          Effect.callback<NodeDgram.Socket, Error>((resume) => {
            const socket = NodeDgram.createSocket("udp4");
            socket.on("message", (message) => datagrams.push(message.toString("hex")));
            socket.on("error", (error) => resume(Effect.fail(error)));
            socket.bind(0, "127.0.0.1", () => resume(Effect.succeed(socket)));
          }),
          (socket) =>
            Effect.callback<void>((resume) => {
              socket.close(() => resume(Effect.void));
            }),
        );
        const address = server.address();
        if (!address || typeof address === "string") return yield* Effect.die("No fixture port.");
        const origin = `http://127.0.0.1:${address.port}`;
        const render = yield* HtmlRender.HtmlRender;
        const result = yield* render.preview({
          html: [
            "<p>safe page</p>",
            `<img src="${origin}/image.png"><iframe src="${origin}/redirect"></iframe>`,
            `<iframe srcdoc="&lt;iframe src='${origin}/nested'&gt;&lt;/iframe&gt;"></iframe>`,
            `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${origin}/prefetch"]}]}</script>`,
            `<script>fetch('${origin}/fetch').catch(()=>{}); const ws = new WebSocket('ws${origin.slice(4)}/socket'); ws.onerror=()=>{};`,
            `console.log('rtc:', typeof RTCPeerConnection, typeof webkitRTCPeerConnection);`,
            `try { const peer = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]}); peer.createDataChannel('x'); peer.createOffer().then(o=>peer.setLocalDescription(o)); } catch {}`,
            `console.log('popup:', window.open('${origin}/popup') === null ? 'blocked' : 'opened');`,
            `addEventListener('load',()=>{location.href='${origin}/navigate';});</script>`,
          ].join(""),
        });
        const text = result.metadata.consoleMessages.map(({ text }) => text);
        expect(text).toContain("rtc: undefined undefined");
        expect(text).toContain("popup: blocked");
        expect(text.join(" ")).not.toContain("PRIVATE_SENTINEL");
        expect(connections).toEqual([]);
        expect(requests).toEqual([]);
        expect(datagrams).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    30_000,
  );

  // Optional controlled PUBLIC fixture: /resource.js synchronously logs
  // PATHWAY_PUBLIC_RESOURCE; /redirect?url=... redirects to that URL.
  // No external network is needed for the two tests above.
  it.live(
    "allows a controlled public resource but refuses its redirect to a private address",
    (ctx) =>
      Effect.gen(function* () {
        const publicOrigin = process.env.PATHWAY_HTML_RENDER_PUBLIC_FIXTURE_ORIGIN;
        if (!publicOrigin)
          return ctx.skip(
            "Set PATHWAY_HTML_RENDER_PUBLIC_FIXTURE_ORIGIN to an authorized public fixture origin.",
          );
        const requests: Array<string> = [];
        const privateServer = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server, Error>((resume) => {
            const server = NodeHttp.createServer((_request, response) =>
              response.end("PRIVATE_SENTINEL"),
            );
            server.on("connection", () => requests.push("tcp"));
            server.on("error", (error) => resume(Effect.fail(error)));
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.closeAllConnections();
              server.close(() => resume(Effect.void));
            }),
        );
        const address = privateServer.address();
        if (!address || typeof address === "string") return yield* Effect.die("No fixture port.");
        const destination = `http://127.0.0.1:${address.port}/secret`;
        const render = yield* HtmlRender.HtmlRender;
        const result = yield* render.preview({
          html: `<p>safe</p><script src="${publicOrigin}/resource.js"></script><iframe src="${publicOrigin}/redirect?url=${encodeURIComponent(destination)}"></iframe>`,
        });
        const text = result.metadata.consoleMessages.map(({ text }) => text).join(" ");
        expect(text).toContain("PATHWAY_PUBLIC_RESOURCE");
        expect(text).not.toContain("PRIVATE_SENTINEL");
        expect(requests).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    30_000,
  );
});
