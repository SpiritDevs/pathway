import { httpRouter, makeFunctionReference } from "convex/server";
import { httpAction } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import type { OrchestratorAttachment } from "@spiritdevs/contracts/aiOrchestrator";

const http = httpRouter();
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
http.route({
  path: "/orchestrator-attachments",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers })),
});
http.route({
  path: "/orchestrator-attachments",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const params = new URL(request.url).searchParams;
      const jobId = params.get("jobId");
      const row = await ctx.runQuery(
        makeFunctionReference<
          "query",
          { id: string; jobId?: string; companyId?: string; generation?: number },
          { storageId: Id<"_storage">; attachment: OrchestratorAttachment }
        >("aiOrchestratorAttachments:read"),
        {
          id: params.get("id") ?? "",
          ...(jobId !== null
            ? {
                jobId,
                companyId: params.get("companyId") ?? "",
                generation: Number(params.get("generation")),
              }
            : {}),
        },
      );
      const blob = await ctx.storage.get(row.storageId);
      if (!blob) return new Response("Attachment unavailable", { status: 404, headers });
      const range = request.headers.get("Range");
      let body = blob;
      let partialHeaders = {};
      if (range !== null) {
        const match = /^bytes=0-(\d+)$/.exec(range);
        const end = Number(match?.[1]);
        if (!match || !Number.isSafeInteger(end) || end < 0 || end >= blob.size)
          return new Response("Invalid range", { status: 416, headers });
        body = blob.slice(0, end + 1);
        partialHeaders = { "Content-Range": `bytes 0-${end}/${blob.size}` };
      }
      return new Response(body, {
        status: range === null ? 200 : 206,
        headers: {
          ...headers,
          ...partialHeaders,
          "Content-Length": String(body.size),
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.attachment.name)}`,
        },
      });
    } catch {
      return new Response("Attachment unavailable", { status: 403, headers });
    }
  }),
});
export default http;
