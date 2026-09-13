// @effect-diagnostics globalFetch:off -- Convex HTTP route streams authorized storage responses.
import { httpRouter, makeFunctionReference } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { signedStorageUrl } from "./lib/assetStorageClient.ts";
const http = httpRouter();
const read = httpAction(async (ctx, request) => {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
  });
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return new Response("Not found", { status: 404, headers });
  const record = await ctx.runQuery(
    makeFunctionReference<
      "query",
      { token: string },
      { key: string; name: string; mimeType: string; byteSize: number } | null
    >("assets:authorizeRead"),
    { token },
  );
  if (!record) return new Response("Not found", { status: 404, headers });
  const range = request.headers.get("Range");
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
    return new Response("Invalid range", { status: 416, headers });
  const upstream = await fetch(await signedStorageUrl(record.key), {
    method: request.method,
    headers: range ? { Range: range } : {},
  });
  if (!upstream.ok)
    return new Response("Asset unavailable", {
      status: upstream.status === 416 ? 416 : 502,
      headers,
    });
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const inline = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav))$/.test(
    record.mimeType,
  );
  headers.set("Content-Type", inline ? record.mimeType : "application/octet-stream");
  headers.set(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(record.name)}`,
  );
  return new Response(upstream.body, { status: upstream.status, headers });
});
http.route({ path: "/assets/read", method: "GET", handler: read });
http.route({
  path: "/assets/read",
  method: "OPTIONS",
  handler: httpAction(
    async () =>
      new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range",
          "Access-Control-Max-Age": "600",
        },
      }),
  ),
});
export default http;
