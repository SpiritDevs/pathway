// @effect-diagnostics nodeBuiltinImport:off -- Local files are streamed through Node's Blob implementation at this upload boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ServerSecretStore } from "../../../auth/ServerSecretStore.ts";
import { CloudSyncEngineRegistry } from "../../../cloud/CloudSyncEngineRegistry.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "../../../cloud/environmentKeys.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "../../../cloud/syncDaemon.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

interface Failure {
  message: string;
}
interface UploadInput {
  path: string;
  clientRequestId: string;
  name?: string | undefined;
  mimeType?: string | undefined;
}
export type AssetManageOperation =
  | "rename"
  | "detach"
  | "trash"
  | "restore"
  | "retry"
  | "share"
  | "revoke"
  | "attach";
export interface AssetManageInput {
  assetId: string;
  operation: AssetManageOperation;
  name?: string | undefined;
  shareId?: string | undefined;
  expiresInDays?: number | undefined;
  messageId?: string | undefined;
  explicitUserInstruction?: boolean | undefined;
}
/** The instruction flag records intent. The cloud gateway independently enforces service grants. */
export function assetManagementArgs(
  companyId: string,
  context: { kind: "thread"; id: string; environmentId: string },
  input: AssetManageInput,
) {
  if (
    ["detach", "trash", "share", "revoke", "attach"].includes(input.operation) &&
    input.explicitUserInstruction !== true
  )
    throw new Error(
      "This asset action requires explicit user instruction. Existing authorization in the conversation counts; this flag does not grant permission.",
    );
  return {
    companyId,
    assetId: input.assetId,
    operation: input.operation,
    context: { ...context, ...(input.messageId ? { messageId: input.messageId } : {}) },
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.shareId !== undefined ? { shareId: input.shareId } : {}),
    ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
    ...(input.explicitUserInstruction !== undefined
      ? { explicitUserInstruction: input.explicitUserInstruction }
      : {}),
  };
}

export interface AssetMcpServiceShape {
  manage(scope: McpInvocationScope, input: AssetManageInput): Effect.Effect<unknown, Failure>;
  upload(scope: McpInvocationScope, input: UploadInput): Effect.Effect<unknown, Failure>;
  list(
    scope: McpInvocationScope,
    input: { cursor?: string | undefined; search?: string | undefined },
  ): Effect.Effect<unknown, Failure>;
  get(scope: McpInvocationScope, assetId: string): Effect.Effect<unknown, Failure>;
  read(scope: McpInvocationScope, assetId: string): Effect.Effect<unknown, Failure>;
}
export class AssetMcpService extends Context.Service<AssetMcpService, AssetMcpServiceShape>()(
  "@spiritdevs/pathway/mcp/toolkits/assets/AssetMcpService",
) {}
const failure = (cause: unknown): Failure => ({
  message:
    typeof cause === "object" && cause !== null && "message" in cause
      ? String(cause.message)
      : String(cause),
});
export const assetReference = (companyId: string, assetId: string) =>
  `pathway-asset:${encodeURIComponent(companyId)}/${encodeURIComponent(assetId)}`;
export const assetMimeType = (path: string) =>
  ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".heic": "image/heic",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".zip": "application/zip",
  })[NodePath.extname(path).toLowerCase()] ?? "application/octet-stream";

/** Resolve symlinks before validating so a workspace link cannot publish another directory's files. */
export async function prepareLocalAsset(path: string, root: string) {
  const [directory, file] = await Promise.all([
    NodeFSP.realpath(root),
    NodeFSP.realpath(NodePath.resolve(root, path)),
  ]);
  const child = NodePath.relative(directory, file);
  if (child === ".." || child.startsWith("../") || NodePath.isAbsolute(child))
    throw new Error(
      "The asset must be inside this thread's workspace. Copy the requested deliverable there first.",
    );
  const info = await NodeFSP.stat(file);
  if (!info.isFile() || info.size === 0)
    throw new Error("Choose a nonempty regular file to upload.");
  if (info.size > 250 * 1024 * 1024) throw new Error("This file exceeds the 250 MB upload limit.");
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  const after = await NodeFSP.stat(file);
  if (after.mtimeMs !== info.mtimeMs || after.size !== info.size || after.ino !== info.ino)
    throw new Error("The file changed while preparing it. Finish writing it before uploading.");
  return {
    file,
    byteSize: info.size,
    checksum: hash.digest("hex"),
    modified: info.mtimeMs,
    inode: info.ino,
  };
}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const registry = yield* Effect.serviceOption(CloudSyncEngineRegistry);
  const secrets = yield* Effect.serviceOption(ServerSecretStore);
  const resolveScope = Effect.fn("assets.resolveScope")(function* (scope: McpInvocationScope) {
    if (!scope.capabilities.has("assets"))
      return yield* Effect.fail({ message: "This MCP credential does not grant asset access." });
    const projection = yield* threads.getThreadProjection(scope.threadId);
    if (projection.thread.deletedAt !== null)
      return yield* Effect.fail({ message: "This thread was deleted." });
    let companyId: string | null = projection.thread.conversationCompanyId ?? null;
    let root: string | null = projection.thread.worktreePath ?? null;
    if (projection.thread.projectId) {
      const project = yield* projects.getById(projection.thread.projectId);
      if (Option.isSome(project)) root ??= project.value.workspaceRoot;
      if (Option.isSome(registry)) {
        const route = yield* registry.value.issueEngineForProject({
          environmentId: scope.environmentId,
          localProjectId: projection.thread.projectId,
        });
        if (route._tag === "Ready") companyId = route.engine.companyId;
      }
    }
    root ??= projection.thread.conversationPath ?? null;
    if (!companyId)
      return yield* Effect.fail({
        message: "This thread's company binding is unavailable. Reconnect before uploading assets.",
      });
    const config = yield* resolveCloudSyncConfig;
    if (config._tag !== "Configured" || Option.isNone(secrets))
      return yield* Effect.fail({
        message: "Cloud upload is unavailable. Your file remains local; retry after reconnecting.",
      });
    const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets.value);
    const tokens = yield* makeCloudSyncTokenProvider({
      environmentId: scope.environmentId,
      secrets: secrets.value,
      dpopKeys,
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    const token = yield* tokens.token;
    const client = new ConvexHttpClient(config.settings.convexUrl);
    client.setAuth(token);
    return {
      client,
      companyId,
      root,
      context: {
        kind: "thread" as const,
        id: String(scope.threadId),
        environmentId: String(scope.environmentId),
      },
    };
  });
  const invoke = (
    client: ConvexHttpClient,
    operation: string,
    kind: "query" | "mutation" | "action",
    args: Record<string, Value>,
  ) =>
    Effect.tryPromise({
      try: () =>
        kind === "query"
          ? client.query(makeFunctionReference<"query">(`assets:${operation}`), args)
          : kind === "mutation"
            ? client.mutation(makeFunctionReference<"mutation">(`assets:${operation}`), args)
            : client.action(makeFunctionReference<"action">(`assets:${operation}`), args),
      catch: failure,
    });
  return AssetMcpService.of({
    manage: Effect.fn("assets.manage")(function* (scope, input) {
      const { client, companyId, context } = yield* resolveScope(scope);
      const args = yield* Effect.try({
        try: () => assetManagementArgs(companyId, context, input),
        catch: failure,
      });
      const result = yield* invoke(client, "agentManage", "mutation", args);
      return { assetRef: assetReference(companyId, input.assetId), result };
    }, Effect.mapError(failure)),
    upload: Effect.fn("assets.upload")(function* (scope, input) {
      const { client, companyId, context, root } = yield* resolveScope(scope);
      if (!root)
        return yield* Effect.fail({
          message: "This conversation has no workspace directory for local deliverables.",
        });
      const file = yield* Effect.tryPromise({
        try: () => prepareLocalAsset(input.path, root),
        catch: failure,
      });
      const mimeType = input.mimeType ?? assetMimeType(file.file);
      const result: unknown = yield* invoke(client, "prepareUpload", "action", {
        companyId,
        context,
        clientRequestId: `${scope.threadId}:${input.clientRequestId}`,
        fileName: input.name ?? NodePath.basename(file.file),
        mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
      });
      if (
        typeof result !== "object" ||
        result === null ||
        !("assetId" in result) ||
        typeof result.assetId !== "string"
      )
        return yield* Effect.fail({
          message: "Upload preparation returned an invalid asset identity.",
        });
      const assetId = result.assetId;
      if ("uploadUrl" in result && typeof result.uploadUrl === "string") {
        const body = yield* Effect.tryPromise({
          try: async () => {
            const current = await NodeFSP.stat(file.file);
            if (
              current.size !== file.byteSize ||
              current.mtimeMs !== file.modified ||
              current.ino !== file.inode
            )
              throw new Error("The file changed before upload. Retry with a new request ID.");
            const body = new FormData();
            body.append(
              "file",
              await NodeFS.openAsBlob(file.file, { type: mimeType }),
              input.name ?? NodePath.basename(file.file),
            );
            return body;
          },
          catch: failure,
        });
        const response = yield* http.execute(
          HttpClientRequest.put(result.uploadUrl).pipe(
            HttpClientRequest.bodyFormData(body),
            HttpClientRequest.setHeader("Range", "bytes=0-"),
            HttpClientRequest.setHeader("x-uploadthing-version", "7.7.4"),
          ),
        );
        if (response.status < 200 || response.status >= 300)
          return yield* Effect.fail({
            message: `Upload pending: storage returned HTTP ${response.status}. Retry with the same clientRequestId; the local file is preserved.`,
          });
        yield* response.text;
      }
      const asset = yield* invoke(client, "finalizeUpload", "action", { companyId, assetId });
      const assetRef = assetReference(companyId, assetId);
      return {
        assetId,
        companyId,
        assetRef,
        markdown: `[${(input.name ?? NodePath.basename(file.file)).replace(/[[\]\\\r\n]/g, "_")}](${assetRef})`,
        asset,
      };
    }, Effect.mapError(failure)),
    list: Effect.fn("assets.list")(function* (scope, input) {
      const { client, companyId, context } = yield* resolveScope(scope);
      return yield* invoke(client, "list", "query", {
        companyId,
        threadId: context.id,
        environmentId: context.environmentId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.search ? { search: input.search } : {}),
      });
    }, Effect.mapError(failure)),
    get: Effect.fn("assets.get")(function* (scope, assetId) {
      const { client, companyId, context } = yield* resolveScope(scope);
      const asset = yield* invoke(client, "get", "query", { companyId, assetId, context });
      return { assetRef: assetReference(companyId, assetId), asset };
    }, Effect.mapError(failure)),
    read: Effect.fn("assets.read")(function* (scope, assetId) {
      const { client, companyId, context } = yield* resolveScope(scope);
      const access = yield* invoke(client, "resolve", "mutation", { companyId, assetId, context });
      return { assetRef: assetReference(companyId, assetId), access };
    }, Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(AssetMcpService, make);
