import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { AssetMcpService } from "./AssetMcpService.ts";

export const AssetMcpFailure = Schema.Struct({ message: Schema.String });
const common = {
  success: Schema.Unknown,
  failure: AssetMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, AssetMcpService],
};
export const AssetUploadTool = Tool.make("assets_upload", {
  ...common,
  description:
    "Upload a requested deliverable from this environment and attach it privately to the current thread. Streams local bytes to durable cloud storage so other devices can open it even while this environment is offline. Return the assetRef in your response as a markdown link. Use the same clientRequestId when retrying. Only report upload or playback readiness when the returned state confirms it. Never upload unrelated files, secrets, or ordinary source references automatically. This does not create a public share link.",
  parameters: Schema.Struct({
    path: Schema.String,
    clientRequestId: Schema.String,
    name: Schema.optional(Schema.String),
    mimeType: Schema.optional(Schema.String),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);
export const AssetListTool = Tool.make("assets_list", {
  ...common,
  description:
    "List uploaded assets attached to this agent's current thread. Paginated, metadata only; cannot enumerate private files in other threads or companies.",
  parameters: Schema.Struct({
    cursor: Schema.optional(Schema.String),
    search: Schema.optional(Schema.String),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const AssetGetTool = Tool.make("assets_get", {
  ...common,
  description:
    "Read current metadata and delivery status for an asset accessible through this thread. Returns its stable renderable reference; does not publish a public URL or return large media bytes.",
  parameters: Schema.Struct({ assetId: Schema.String }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const AssetReadTool = Tool.make("assets_read", {
  ...common,
  description:
    "Resolve an authorized, short-lived download for a thread asset. Do not persist or present this temporary URL as a share link; use the stable assetRef in messages. Read only assets required by the current task.",
  parameters: Schema.Struct({ assetId: Schema.String }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const managementDescription =
  " Requires an explicitly granted asset-management service permission, which the backend checks for this thread. Never impersonate a user or treat an instruction flag as permission. These tools cannot manage another thread's assets.";
const instructed = {
  assetId: Schema.String,
  explicitUserInstruction: Schema.Boolean,
};
export const AssetAttachTool = Tool.make("assets_attach", {
  ...common,
  description:
    "Attach an existing current-thread asset to a message in this thread. Supply messageId when binding a specific message. Set explicitUserInstruction=true only when the user instructed this reuse; prior authorization in the conversation counts. This does not grant new audiences access." +
    managementDescription,
  parameters: Schema.Struct({ ...instructed, messageId: Schema.optional(Schema.String) }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const AssetRenameTool = Tool.make("assets_rename", {
  ...common,
  description:
    "Change a current-thread asset's display name. Its immutable contents and historical message identity stay the same." +
    managementDescription,
  parameters: Schema.Struct({ assetId: Schema.String, name: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const AssetDetachTool = Tool.make("assets_detach", {
  ...common,
  description:
    "Remove a current-thread attachment binding while preserving the file's other usages. Supply messageId for a message binding. Requires explicit user instruction; previously given authorization counts. This is different from deleting the asset." +
    managementDescription,
  parameters: Schema.Struct({ ...instructed, messageId: Schema.optional(Schema.String) }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const AssetTrashTool = Tool.make("assets_trash", {
  ...common,
  description:
    "Move an explicitly requested current-thread asset to 30-day Trash, revoke its share links, and leave deleted-file placeholders in history. Requires explicit user instruction; do not infer deletion from cleanup suggestions." +
    managementDescription,
  parameters: Schema.Struct(instructed),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const AssetRestoreTool = Tool.make("assets_restore", {
  ...common,
  description:
    "Restore a trashed current-thread asset to surviving contexts. Revoked sharing links are not reactivated." +
    managementDescription,
  parameters: Schema.Struct({ assetId: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const AssetShareTool = Tool.make("assets_share", {
  ...common,
  description:
    "Create an externally accessible link only when the user explicitly asked for public sharing. Defaults to seven days; expiry must be between one and 30 days. Existing sharing authorization counts. Requires the separate assets.share grant in addition to management permission. Return the resulting share URL only after success." +
    managementDescription,
  parameters: Schema.Struct({
    ...instructed,
    expiresInDays: Schema.optional(
      Schema.Number.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(30)),
    ),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);
export const AssetRevokeTool = Tool.make("assets_revoke_share", {
  ...common,
  description:
    "Revoke an existing current-thread asset share grant immediately, denying new reads. Requires explicit user instruction and the assets.share grant. Already downloaded bytes cannot be recalled." +
    managementDescription,
  parameters: Schema.Struct({ ...instructed, shareId: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);
export const AssetRetryTool = Tool.make("assets_retry", {
  ...common,
  description:
    "Retry failed preview processing for a verified uploaded asset. This does not re-upload or replace the original. For a failed original upload, call assets_upload with the same clientRequestId instead; do not report preview readiness until assets_get confirms it." +
    managementDescription,
  parameters: Schema.Struct({ assetId: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AssetsToolkit = Toolkit.make(
  AssetUploadTool,
  AssetListTool,
  AssetGetTool,
  AssetReadTool,
  AssetAttachTool,
  AssetRenameTool,
  AssetDetachTool,
  AssetTrashTool,
  AssetRestoreTool,
  AssetShareTool,
  AssetRevokeTool,
  AssetRetryTool,
);
