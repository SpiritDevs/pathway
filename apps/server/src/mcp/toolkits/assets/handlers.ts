import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import {
  AssetMcpService,
  type AssetManageOperation,
  type AssetManageInput,
} from "./AssetMcpService.ts";
import { AssetsToolkit } from "./tools.ts";
const manageAsset = Effect.fn("assets.manageHandler")(function* (
  operation: AssetManageOperation,
  input: Omit<AssetManageInput, "operation">,
) {
  return yield* (yield* AssetMcpService).manage(yield* McpInvocationContext, {
    ...input,
    operation,
  });
});
export const AssetsToolkitHandlersLive = AssetsToolkit.toLayer({
  assets_attach: (input) => manageAsset("attach", input),
  assets_rename: (input) => manageAsset("rename", input),
  assets_detach: (input) => manageAsset("detach", input),
  assets_trash: (input) => manageAsset("trash", input),
  assets_restore: (input) => manageAsset("restore", input),
  assets_share: (input) => manageAsset("share", input),
  assets_revoke_share: (input) => manageAsset("revoke", input),
  assets_retry: (input) => manageAsset("retry", input),
  assets_upload: (input) =>
    Effect.gen(function* () {
      return yield* (yield* AssetMcpService).upload(yield* McpInvocationContext, input);
    }),
  assets_list: (input) =>
    Effect.gen(function* () {
      return yield* (yield* AssetMcpService).list(yield* McpInvocationContext, input);
    }),
  assets_get: (input) =>
    Effect.gen(function* () {
      return yield* (yield* AssetMcpService).get(yield* McpInvocationContext, input.assetId);
    }),
  assets_read: (input) =>
    Effect.gen(function* () {
      return yield* (yield* AssetMcpService).read(yield* McpInvocationContext, input.assetId);
    }),
});
