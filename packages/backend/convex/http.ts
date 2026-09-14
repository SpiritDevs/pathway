import { httpRouter, makeFunctionReference } from "convex/server";
import { httpAction } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import type { OrchestratorAttachment } from "@spiritdevs/contracts/aiOrchestrator";

const http = httpRouter();
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
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
      return new Response(blob, {
        headers: {
          ...headers,
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
