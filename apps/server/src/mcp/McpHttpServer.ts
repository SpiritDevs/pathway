import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer as SdkMcpServer,
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  SUPPORTED_PROTOCOL_VERSIONS,
  classifyInboundRequest,
  createMcpHandler,
  fromJsonSchema,
  isJsonContentType,
  type CallToolResult,
  type InboundModernRoute,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type McpHttpHandler,
  type ServerEvent,
} from "@modelcontextprotocol/server";
import Mime from "@effect/platform-node/Mime";
import { rpcSessionLayer } from "@spiritdevs/client-runtime/rpc";
import {
  EmailMcpTaskState,
  EmailMcpWaitForInput,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EmailProjectSettings,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as PeerEnvironments from "../cloud/peerEnvironments.ts";
import * as RemoteDispatch from "../cloud/remoteDispatch.ts";
import * as ServerConfig from "../config.ts";
import * as EmailStoreLive from "../email/EmailStore.ts";
import * as EmailWaitStoreLive from "../email/EmailWaitStore.ts";
import { IssueTrackerService } from "../issues/IssueTrackerService.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import { EmailMcpProjectScopeLive } from "./toolkits/email/EmailMcpService.ts";
import * as EmailMcpService from "./toolkits/email/EmailMcpService.ts";
import { EmailToolkitHandlersLive } from "./toolkits/email/handlers.ts";
import { EmailToolkit } from "./toolkits/email/tools.ts";
import { IssuesToolkitHandlersLive } from "./toolkits/issues/handlers.ts";
import {
  IssuesMcpDetail,
  IssuesMcpGetAttachmentResult,
  IssuesToolkit,
  type IssuesMcpAttachment,
} from "./toolkits/issues/tools.ts";
import { OrchestratorToolkitHandlersLive } from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { WorktreeToolkitHandlersLive } from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_PROTOCOL_VERSION,
  ...SUPPORTED_PROTOCOL_VERSIONS,
];
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const PATHWAY_MCP_SERVER_INFO = { name: "Pathway", version: packageJson.version } as const;
const TASK_NOTIFICATION_FILTER = MCP_TASKS_EXTENSION;
const REQUIRED_TASKS_CAPABILITIES = {
  extensions: { [MCP_TASKS_EXTENSION]: {} },
};

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token);
        if (!invocation) {
          // Without this the only symptom of a dead credential is the agent
          // quietly losing the whole `pathway` toolkit for the rest of its
          // session, with nothing on the server to explain why.
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

interface EncodedToolResult {
  readonly encodedResult: object | string | number | boolean | null;
}

const ISSUES_MCP_INLINE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

interface LoadedIssueAttachment {
  readonly data?: string;
  readonly kind: "image" | "video" | "file";
  readonly mimeType: string;
  readonly path: string;
  readonly sizeBytes: number;
}

const encodeIssueDetailJson = Schema.encodeSync(Schema.fromJsonString(IssuesMcpDetail));
const encodeIssueAttachmentResultJson = Schema.encodeSync(
  Schema.fromJsonString(IssuesMcpGetAttachmentResult),
);

interface BuiltToolkit {
  readonly tools: Record<string, Tool.Any>;
  readonly handle: (
    name: string,
    payload: object,
  ) => Effect.Effect<Stream.Stream<EncodedToolResult, object>, AiError.AiError>;
}

const toolAnnotations = (tool: Tool.Any) => ({
  ...Context.getOption(tool.annotations, Tool.Title).pipe(
    Option.map((title) => ({ title })),
    Option.getOrUndefined,
  ),
  readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
  destructiveHint: Context.get(tool.annotations, Tool.Destructive),
  idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
  openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
});

const isAiError = Schema.is(AiError.AiError);

const toolFailure = <E>(cause: Cause.Cause<E>): CallToolResult => {
  const firstFailure = cause.reasons.find(Cause.isFailReason)?.error;
  const message = isAiError(firstFailure)
    ? firstFailure.reason._tag === "ToolParameterValidationError"
      ? firstFailure.reason.message
      : "Tool execution failed due to an internal server error."
    : firstFailure instanceof Error
      ? firstFailure.message
      : "Tool execution failed due to an internal server error.";
  return { isError: true, content: [{ type: "text", text: message }] };
};

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    Predicate.hasProperty(firstFailure, "_tag") && typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result: CallToolResult = {
    isError: true,
    structuredContent: {
      error: { _tag: errorTag, operation: "snapshot", failureCount: failures.length },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  };
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const invokeBuiltTool = (
  built: BuiltToolkit,
  name: string,
  payload: object,
  invocation: McpInvocationContext.McpInvocationScope,
  runtimeContext: Context.Context<never>,
): Promise<CallToolResult> =>
  Effect.runPromiseWith(runtimeContext)(
    built.handle(name, payload).pipe(
      Stream.unwrap,
      Stream.run(Sink.last()),
      Effect.flatMap(Effect.fromOption),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.tapCause(Effect.logError),
      Effect.matchCause({
        onFailure: toolFailure,
        onSuccess: ({ encodedResult }) => ({
          isError: false,
          ...(typeof encodedResult === "object" ? { structuredContent: encodedResult } : {}),
          content: [{ type: "text" as const, text: JSON.stringify(encodedResult) }],
        }),
      }),
    ),
  );

const inspectIssueAttachment = Effect.fn("McpHttpServer.inspectIssueAttachment")(function* (
  attachmentId: string,
): Effect.fn.Return<
  LoadedIssueAttachment | null,
  never,
  ServerConfig.ServerConfig | FileSystem.FileSystem
> {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = resolveAttachmentPathById({
    attachmentsDir: config.attachmentsDir,
    attachmentId,
  });
  if (path === null) return null;
  const mimeType = Mime.getType(path);
  if (mimeType === null) return null;
  const info = yield* fileSystem.stat(path).pipe(Effect.orElseSucceed(() => null));
  return info === null || info.type !== "File"
    ? null
    : {
        kind: mimeType.startsWith("image/")
          ? "image"
          : mimeType.startsWith("video/")
            ? "video"
            : "file",
        mimeType,
        path,
        sizeBytes: Number(info.size),
      };
});

const loadIssueAttachmentImage = Effect.fn("McpHttpServer.loadIssueAttachmentImage")(function* (
  attachment: LoadedIssueAttachment | null,
): Effect.fn.Return<LoadedIssueAttachment | null, never, FileSystem.FileSystem> {
  if (attachment === null || attachment.kind !== "image") return attachment;
  const fileSystem = yield* FileSystem.FileSystem;
  const bytes = yield* fileSystem.readFile(attachment.path).pipe(Effect.orElseSucceed(() => null));
  return bytes === null ? null : { ...attachment, data: Encoding.encodeBase64(bytes) };
});

const withIssueAttachmentMetadata = (
  attachment: IssuesMcpAttachment,
  loaded: LoadedIssueAttachment | null,
): IssuesMcpAttachment =>
  loaded === null
    ? attachment
    : {
        ...attachment,
        kind: loaded.kind,
        mimeType: loaded.mimeType,
        sizeBytes: loaded.sizeBytes,
      };

const issueAttachmentLabel = (
  issueKey: string,
  attachment: IssuesMcpAttachment,
  position: number,
  total: number,
) =>
  [
    `Issue attachment ${position} of ${total} on ${issueKey}`,
    `Attachment id: ${attachment.attachmentId}`,
    `Source: comment ${attachment.commentNumber} by ${attachment.author} at ${attachment.commentCreatedAt}`,
    `Comment body:\n${attachment.commentBody}`,
  ].join("\n");

export const issueDetailCallToolResult = Effect.fn("McpHttpServer.issueDetailCallToolResult")(
  function* (
    detail: IssuesMcpDetail,
  ): Effect.fn.Return<CallToolResult, never, ServerConfig.ServerConfig | FileSystem.FileSystem> {
    const loadedById = new Map<string, LoadedIssueAttachment | null>();
    const attachments = yield* Effect.forEach(detail.attachments, (attachment) =>
      inspectIssueAttachment(attachment.attachmentId).pipe(
        Effect.tap((loaded) => Effect.sync(() => loadedById.set(attachment.attachmentId, loaded))),
        Effect.map((loaded) => withIssueAttachmentMetadata(attachment, loaded)),
      ),
    );
    const enrichedDetail = { ...detail, attachments };
    const content: CallToolResult["content"] = [
      { type: "text", text: encodeIssueDetailJson(enrichedDetail) },
    ];
    let included = 0;
    let includedBytes = 0;
    const eager = attachments.slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    for (const [index, attachment] of eager.entries()) {
      const image = yield* loadIssueAttachmentImage(
        loadedById.get(attachment.attachmentId) ?? null,
      );
      if (
        image === null ||
        image.data === undefined ||
        includedBytes + image.sizeBytes > ISSUES_MCP_INLINE_ATTACHMENT_MAX_BYTES
      ) {
        continue;
      }
      included += 1;
      includedBytes += image.sizeBytes;
      content.push(
        {
          type: "text",
          text: issueAttachmentLabel(detail.key, attachment, index + 1, attachments.length),
        },
        { type: "image", data: image.data, mimeType: image.mimeType },
      );
    }
    if (included < attachments.length) {
      const omitted = attachments.length - included;
      content.push({
        type: "text",
        text: `${omitted} issue attachment${omitted === 1 ? " was" : "s were"} not included directly in this bounded response. Use issues_get_attachment for another listed image; video evidence remains playable on the Pathway issue.`,
      });
    }
    return { isError: false, structuredContent: enrichedDetail, content };
  },
);

export const issueAttachmentCallToolResult = Effect.fn(
  "McpHttpServer.issueAttachmentCallToolResult",
)(function* (
  result: IssuesMcpGetAttachmentResult,
): Effect.fn.Return<CallToolResult, never, ServerConfig.ServerConfig | FileSystem.FileSystem> {
  const inspected = yield* inspectIssueAttachment(result.attachment.attachmentId);
  const image = yield* loadIssueAttachmentImage(inspected);
  const enrichedResult = {
    ...result,
    attachment: withIssueAttachmentMetadata(result.attachment, image),
  };
  if (image === null) {
    return {
      isError: true,
      structuredContent: enrichedResult,
      content: [
        {
          type: "text",
          text: `Attachment ${result.attachment.attachmentId} belongs to ${result.key}, but its bytes are unavailable.`,
        },
      ],
    };
  }
  if (image.data === undefined) {
    return {
      isError: false,
      structuredContent: enrichedResult,
      content: [
        { type: "text", text: encodeIssueAttachmentResultJson(enrichedResult) },
        { type: "text", text: issueAttachmentLabel(result.key, enrichedResult.attachment, 1, 1) },
        {
          type: "text",
          text: `This attachment is ${image.mimeType} (${image.sizeBytes} bytes). MCP has no inline video content block; it is attached to and playable from the Pathway issue.`,
        },
      ],
    };
  }
  return {
    isError: false,
    structuredContent: enrichedResult,
    content: [
      { type: "text", text: encodeIssueAttachmentResultJson(enrichedResult) },
      { type: "text", text: issueAttachmentLabel(result.key, enrichedResult.attachment, 1, 1) },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ],
  };
});

const invokeIssueTool = (
  built: BuiltToolkit,
  name: "issues_get" | "issues_get_attachment",
  payload: object,
  invocation: McpInvocationContext.McpInvocationScope,
  attachmentContext: Context.Context<ServerConfig.ServerConfig | FileSystem.FileSystem>,
  runtimeContext: Context.Context<never>,
): Promise<CallToolResult> =>
  Effect.runPromiseWith(runtimeContext)(
    built.handle(name, payload).pipe(
      Stream.unwrap,
      Stream.run(Sink.last()),
      Effect.flatMap(Effect.fromOption),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.tapCause(Effect.logError),
      Effect.matchCauseEffect({
        onFailure: (cause) => Effect.succeed(toolFailure(cause)),
        onSuccess: ({ encodedResult }) =>
          (name === "issues_get"
            ? issueDetailCallToolResult(encodedResult as IssuesMcpDetail)
            : issueAttachmentCallToolResult(encodedResult as IssuesMcpGetAttachmentResult)
          ).pipe(Effect.provide(attachmentContext)),
      }),
    ),
  );

const invokeSnapshot = (
  built: BuiltToolkit,
  payload: object,
  invocation: McpInvocationContext.McpInvocationScope,
  runtimeContext: Context.Context<never>,
): Promise<CallToolResult> =>
  Effect.runPromiseWith(runtimeContext)(
    built.handle("preview_snapshot", payload).pipe(
      Stream.unwrap,
      Stream.run(Sink.last()),
      Effect.flatMap(Effect.fromOption),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.matchCauseEffect({
        onFailure: previewSnapshotFailure,
        onSuccess: ({ encodedResult }) => {
          const snapshot = encodedResult as {
            readonly screenshot: {
              readonly mimeType: "image/png";
              readonly data: string;
              readonly width: number;
              readonly height: number;
            };
            readonly [key: string]: object | string | number | boolean | null;
          };
          const { screenshot, ...page } = snapshot;
          const metadata = {
            ...page,
            screenshot: {
              mimeType: screenshot.mimeType,
              width: screenshot.width,
              height: screenshot.height,
            },
          };
          return Effect.succeed({
            isError: false,
            structuredContent: metadata,
            content: [
              { type: "text" as const, text: JSON.stringify(metadata) },
              { type: "image" as const, data: screenshot.data, mimeType: screenshot.mimeType },
            ],
          } satisfies CallToolResult);
        },
      }),
    ),
  );

const TaskIdParams = Schema.Struct({ taskId: Schema.String });
const TaskUpdateParams = Schema.Struct({
  taskId: Schema.String,
  inputResponses: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeEmailWaitForInput = Schema.decodeUnknownEffect(EmailMcpWaitForInput);
const isEmailWaitForInput = Schema.is(EmailMcpWaitForInput);
const decodeTaskIdParams = Schema.decodeUnknownEffect(TaskIdParams);
const decodeTaskUpdateParams = Schema.decodeUnknownEffect(TaskUpdateParams);
const isEmailTaskState = Schema.is(EmailMcpTaskState);

const jsonRpcResult = (id: JSONRPCRequest["id"], result: object): Response =>
  Response.json({
    jsonrpc: "2.0",
    id,
    result: {
      ...result,
      resultType: "complete",
      _meta: { [SERVER_INFO_META_KEY]: PATHWAY_MCP_SERVER_INFO },
    },
  });

const jsonRpcError = (
  id: JSONRPCRequest["id"] | null,
  code: number,
  message: string,
  data?: object,
  status = 400,
): Response =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status },
  );

const hasTasksCapability = (message: JSONRPCRequest | JSONRPCNotification): boolean => {
  const capabilities = message.params?._meta?.[CLIENT_CAPABILITIES_META_KEY];
  return (
    Predicate.hasProperty(capabilities, "extensions") &&
    Predicate.hasProperty(capabilities.extensions, MCP_TASKS_EXTENSION)
  );
};

const invocationSubscriptionKey = (
  invocation: McpInvocationContext.McpInvocationScope,
  requestId: JSONRPCRequest["id"],
) => `${invocation.providerSessionId}:${String(requestId)}`;

const notificationForServerEvent = (
  event: ServerEvent,
  subscriptionId: JSONRPCRequest["id"],
): object | undefined => {
  const meta = { [SUBSCRIPTION_ID_META_KEY]: subscriptionId };
  switch (event.kind) {
    case "tools_list_changed":
      return {
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: { _meta: meta },
      };
    case "prompts_list_changed":
      return {
        jsonrpc: "2.0",
        method: "notifications/prompts/list_changed",
        params: { _meta: meta },
      };
    case "resources_list_changed":
      return {
        jsonrpc: "2.0",
        method: "notifications/resources/list_changed",
        params: { _meta: meta },
      };
    case "resource_updated":
      return {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: event.uri, _meta: meta },
      };
  }
};

const createTaskNotification = (task: EmailMcpTaskState, subscriptionId: JSONRPCRequest["id"]) => ({
  jsonrpc: "2.0",
  method: "notifications/tasks",
  params: { ...task, _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId } },
});

export interface PathwayMcpHandler {
  readonly fetch: (
    request: Request,
    invocation: McpInvocationContext.McpInvocationScope,
  ) => Promise<Response>;
  readonly close: () => Promise<void>;
  readonly notify: McpHttpHandler["notify"];
}

interface HandlerBuildOptions {
  readonly toolkits: ReadonlyArray<BuiltToolkit>;
  readonly snapshot?: BuiltToolkit;
  readonly issueAttachmentContext?: Context.Context<
    ServerConfig.ServerConfig | FileSystem.FileSystem
  >;
  readonly email?: EmailMcpService.EmailMcpService["Service"];
  readonly projects?: ReadonlyArray<EmailProjectSettings>;
  readonly runtimeContext: Context.Context<never>;
}

const makePathwayMcpHandler = (options: HandlerBuildOptions): PathwayMcpHandler => {
  const customSubscriptions = new Map<string, () => void>();
  const registeredTools = options.toolkits.flatMap((built) =>
    Object.values(built.tools).map((tool) => ({
      built,
      tool,
      inputSchema: fromJsonSchema<object>(Tool.getJsonSchema(tool)),
      description: Tool.getDescription(tool),
      annotations: toolAnnotations(tool),
    })),
  );
  const snapshotRegistration =
    options.snapshot === undefined
      ? undefined
      : {
          built: options.snapshot,
          tool: PreviewSnapshotTool,
          inputSchema: fromJsonSchema<object>(Tool.getJsonSchema(PreviewSnapshotTool)),
          description: Tool.getDescription(PreviewSnapshotTool),
          annotations: toolAnnotations(PreviewSnapshotTool),
        };
  const sdk = createMcpHandler(
    ({ authInfo }) => {
      const invocation = authInfo?.extra?.invocation as
        | McpInvocationContext.McpInvocationScope
        | undefined;
      if (invocation === undefined) throw new Error("Missing authenticated MCP invocation.");
      const server = new SdkMcpServer(PATHWAY_MCP_SERVER_INFO, {
        capabilities: {
          tools: {},
          ...(options.email === undefined ? {} : { resources: { subscribe: true } }),
          ...(options.email === undefined ? {} : { extensions: { [MCP_TASKS_EXTENSION]: {} } }),
        },
        instructions:
          "Pathway tools act on the authenticated coding-agent thread and its environment.",
        supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
      });
      for (const registration of registeredTools) {
        const { annotations, built, description, inputSchema, tool } = registration;
        server.registerTool<typeof inputSchema, typeof inputSchema>(
          tool.name,
          {
            ...(description === undefined ? {} : { description }),
            inputSchema,
            annotations,
          },
          (payload) =>
            (tool.name === "issues_get" || tool.name === "issues_get_attachment") &&
            options.issueAttachmentContext !== undefined
              ? invokeIssueTool(
                  built,
                  tool.name,
                  payload,
                  invocation,
                  options.issueAttachmentContext,
                  options.runtimeContext,
                )
              : invokeBuiltTool(built, tool.name, payload, invocation, options.runtimeContext),
        );
      }
      if (snapshotRegistration !== undefined) {
        const { annotations, built, description, inputSchema, tool } = snapshotRegistration;
        server.registerTool<typeof inputSchema, typeof inputSchema>(
          tool.name,
          {
            ...(description === undefined ? {} : { description }),
            inputSchema,
            annotations,
          },
          (payload) => invokeSnapshot(built, payload, invocation, options.runtimeContext),
        );
      }
      if (options.email !== undefined) {
        for (const project of options.projects ?? []) {
          const uri = `email://project/${project.mailSlug}/inbox`;
          server.registerResource(
            `Email inbox: ${project.mailSlug}`,
            uri,
            {
              description: `Captured email inbox for ${project.mailSlug}`,
              mimeType: "application/json",
            },
            async () => {
              const messages = await Effect.runPromiseWith(options.runtimeContext)(
                options.email!.list(invocation, { project: project.mailSlug }),
              );
              return {
                contents: [{ uri, mimeType: "application/json", text: JSON.stringify(messages) }],
              };
            },
          );
        }
      }
      return server;
    },
    { legacy: "stateless", responseMode: "auto" },
  );

  const serveListen = (
    route: InboundModernRoute & { readonly messageKind: "request" },
    invocation: McpInvocationContext.McpInvocationScope,
  ): Response => {
    const message = route.message;
    const notifications = Predicate.hasProperty(message.params, "notifications")
      ? message.params.notifications
      : {};
    const wantsTasks =
      Predicate.hasProperty(notifications, TASK_NOTIFICATION_FILTER) &&
      notifications[TASK_NOTIFICATION_FILTER] === true;
    if (wantsTasks && !hasTasksCapability(message)) {
      return jsonRpcError(message.id, -32021, "Missing required client capability", {
        requiredCapabilities: REQUIRED_TASKS_CAPABILITIES,
      });
    }

    const subscriptionId = message.id;
    const encoder = new TextEncoder();
    const cleanupFns = new Set<() => void>();
    const key = invocationSubscriptionKey(invocation, message.id);
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const send = (value: object) => {
      if (!closed)
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(value)}\n\n`));
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      for (const finish of cleanupFns) finish();
      cleanupFns.clear();
      customSubscriptions.delete(key);
    };
    const close = () => {
      if (closed) return;
      controller.close();
      cleanup();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        const honored = {
          ...(Predicate.hasProperty(notifications, "toolsListChanged") &&
          notifications.toolsListChanged === true
            ? { toolsListChanged: true }
            : {}),
          ...(Predicate.hasProperty(notifications, "promptsListChanged") &&
          notifications.promptsListChanged === true
            ? { promptsListChanged: true }
            : {}),
          ...(Predicate.hasProperty(notifications, "resourcesListChanged") &&
          notifications.resourcesListChanged === true
            ? { resourcesListChanged: true }
            : {}),
          ...(Predicate.hasProperty(notifications, "resourceSubscriptions") &&
          Array.isArray(notifications.resourceSubscriptions)
            ? { resourceSubscriptions: notifications.resourceSubscriptions }
            : {}),
          ...(wantsTasks && options.email !== undefined
            ? { [TASK_NOTIFICATION_FILTER]: true }
            : {}),
        };
        let markTaskReady = () => {};
        const taskReady =
          wantsTasks && options.email !== undefined
            ? new Promise<void>((resolve) => {
                markTaskReady = resolve;
              })
            : Promise.resolve();
        let markAcknowledged = () => {};
        const acknowledged = new Promise<void>((resolve) => {
          markAcknowledged = resolve;
        });
        if (wantsTasks && options.email !== undefined) {
          const cancel = Effect.runCallbackWith(options.runtimeContext)(
            Effect.scoped(
              Effect.gen(function* () {
                const taskStream = yield* options.email!.subscribeTaskNotifications(invocation);
                yield* Effect.sync(markTaskReady);
                yield* Effect.promise(() => acknowledged);
                yield* Stream.runForEach(taskStream, (task) =>
                  Effect.sync(() => send(createTaskNotification(task, subscriptionId))),
                );
              }),
            ).pipe(Effect.orDie),
          );
          cleanupFns.add(cancel);
        }
        return taskReady.then(() => {
          const unsubscribe = sdk.bus.subscribe((event) => {
            const optedIn =
              (event.kind === "tools_list_changed" && honored.toolsListChanged === true) ||
              (event.kind === "prompts_list_changed" && honored.promptsListChanged === true) ||
              (event.kind === "resources_list_changed" && honored.resourcesListChanged === true) ||
              (event.kind === "resource_updated" &&
                "resourceSubscriptions" in honored &&
                honored.resourceSubscriptions.includes(event.uri));
            if (optedIn) {
              const notification = notificationForServerEvent(event, subscriptionId);
              if (notification !== undefined) send(notification);
            }
          });
          cleanupFns.add(unsubscribe);
          send({
            jsonrpc: "2.0",
            method: "notifications/subscriptions/acknowledged",
            params: {
              notifications: honored,
              _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
            },
          });
          markAcknowledged();
          customSubscriptions.set(key, close);
        });
      },
      cancel: cleanup,
    });
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
    });
  };

  const runTaskRequest = async (
    route: InboundModernRoute & { readonly messageKind: "request" },
    invocation: McpInvocationContext.McpInvocationScope,
  ): Promise<Response | undefined> => {
    const { message } = route;
    if (options.email === undefined) return undefined;
    const tasksSupported = hasTasksCapability(message);
    if (message.method === "tools/call") {
      if (
        !tasksSupported ||
        !Predicate.hasProperty(message.params, "name") ||
        message.params.name !== "email_wait_for"
      ) {
        return undefined;
      }
      const input = await Effect.runPromise(
        decodeEmailWaitForInput(
          Predicate.hasProperty(message.params, "arguments") ? message.params.arguments : {},
        ),
      ).catch((error) => error);
      if (!isEmailWaitForInput(input)) {
        return jsonRpcError(message.id, -32602, String(input));
      }
      const created = await Effect.runPromiseWith(options.runtimeContext)(
        options.email.waitFor(invocation, input, true),
      ).catch((error) => error);
      if (!Predicate.hasProperty(created, "task")) {
        return jsonRpcError(message.id, -32602, String(created));
      }
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          resultType: "task",
          ...created,
          _meta: { [SERVER_INFO_META_KEY]: PATHWAY_MCP_SERVER_INFO },
        },
      });
    }
    if (
      message.method !== "tasks/get" &&
      message.method !== "tasks/update" &&
      message.method !== "tasks/cancel"
    ) {
      return undefined;
    }
    if (!tasksSupported) {
      return jsonRpcError(message.id, -32021, "Missing required client capability", {
        requiredCapabilities: REQUIRED_TASKS_CAPABILITIES,
      });
    }
    const taskId = await Effect.runPromise(
      (message.method === "tasks/update" ? decodeTaskUpdateParams : decodeTaskIdParams)(
        message.params,
      ).pipe(Effect.map(({ taskId: decodedTaskId }) => decodedTaskId)),
    ).catch((error) => error);
    if (typeof taskId !== "string") return jsonRpcError(message.id, -32602, String(taskId));
    const task = await Effect.runPromiseWith(options.runtimeContext)(
      message.method === "tasks/get"
        ? options.email.getTask(invocation, taskId)
        : message.method === "tasks/update"
          ? options.email.updateTask(invocation, taskId)
          : message.method === "tasks/cancel"
            ? options.email.cancelTask(invocation, taskId)
            : options.email.getTask(invocation, taskId),
    ).catch((error) => error);
    return !isEmailTaskState(task)
      ? jsonRpcError(message.id, -32602, String(task))
      : jsonRpcResult(message.id, { task });
  };

  return {
    fetch: async (request, invocation) => {
      let parsedBody: unknown;
      if (request.method === "POST" && isJsonContentType(request.headers.get("content-type"))) {
        parsedBody = await request
          .clone()
          .json()
          .catch(() => undefined);
      }
      const classified = classifyInboundRequest({
        httpMethod: request.method,
        ...(request.headers.get("mcp-protocol-version") === null
          ? {}
          : { protocolVersionHeader: request.headers.get("mcp-protocol-version")! }),
        ...(request.headers.get("mcp-method") === null
          ? {}
          : { mcpMethodHeader: request.headers.get("mcp-method")! }),
        ...(request.headers.get("mcp-name") === null
          ? {}
          : { mcpNameHeader: request.headers.get("mcp-name")! }),
        ...(parsedBody === undefined ? {} : { body: parsedBody }),
      });
      if (classified.kind === "modern") {
        if (classified.messageKind === "request") {
          if (classified.message.method === "subscriptions/listen") {
            return serveListen(classified, invocation);
          }
          const taskResponse = await runTaskRequest(classified, invocation);
          if (taskResponse !== undefined) return taskResponse;
        } else if (classified.message.method === "notifications/cancelled") {
          const requestId = Predicate.hasProperty(classified.message.params, "requestId")
            ? classified.message.params.requestId
            : undefined;
          if (typeof requestId === "string" || typeof requestId === "number") {
            customSubscriptions.get(invocationSubscriptionKey(invocation, requestId))?.();
          }
        }
      }
      return sdk.fetch(request, {
        parsedBody,
        authInfo: {
          token: "pathway-mcp-credential",
          clientId: invocation.providerInstanceId,
          scopes: [],
          extra: { invocation },
        },
      });
    },
    close: async () => {
      for (const close of customSubscriptions.values()) close();
      await sdk.close();
    },
    notify: sdk.notify,
  };
};

const makeScopedPathwayMcpHandler = (options: HandlerBuildOptions) =>
  Effect.acquireRelease(
    Effect.sync(() => makePathwayMcpHandler(options)),
    (handler) => Effect.promise(() => handler.close()).pipe(Effect.orDie),
  );

const EmailMcpServiceLive = EmailMcpService.layer.pipe(
  Layer.provideMerge(EmailMcpProjectScopeLive),
);

const WebSocketConstructorLive = Layer.unwrap(
  Effect.promise(() =>
    typeof Bun === "undefined"
      ? import("@effect/platform-node/NodeSocket").then(
          (module) => module.layerWebSocketConstructor,
        )
      : import("@effect/platform-bun/BunSocket").then((module) => module.layerWebSocketConstructor),
  ),
);

const RemoteDispatchLive = RemoteDispatch.layer.pipe(
  Layer.provide(
    PeerEnvironments.layer.pipe(
      Layer.provide(rpcSessionLayer.pipe(Layer.provide(WebSocketConstructorLive))),
    ),
  ),
);

const OrchestratorMcpServiceLive = OrchestratorMcpService.layer.pipe(
  Layer.provide(RemoteDispatchLive),
);

const ToolkitHandlersLive = Layer.mergeAll(
  PreviewStandardToolkitHandlersLive,
  PreviewSnapshotToolkitHandlersLive,
  IssuesToolkitHandlersLive,
  OrchestratorToolkitHandlersLive,
  WorktreeToolkitHandlersLive,
  EmailToolkitHandlersLive,
);

const McpToolkitServicesLive = Layer.mergeAll(
  OrchestratorMcpServiceLive,
  WorktreeMcpService.layer,
  EmailMcpServiceLive,
);

/**
 * Build the exact tool surface served by the production Pathway MCP endpoint.
 * Test handlers use this same effect so a toolkit cannot disappear from production unnoticed.
 */
const buildPathwayMcpToolkits = Effect.gen(function* () {
  const standardPreview = (yield* PreviewStandardToolkit) as unknown as BuiltToolkit;
  const snapshot = (yield* PreviewSnapshotToolkit) as unknown as BuiltToolkit;
  const issues = (yield* IssuesToolkit) as unknown as BuiltToolkit;
  const orchestrator = (yield* OrchestratorToolkit) as unknown as BuiltToolkit;
  const worktree = (yield* WorktreeToolkit) as unknown as BuiltToolkit;
  const email = (yield* EmailToolkit) as unknown as BuiltToolkit;
  return {
    toolkits: [standardPreview, issues, orchestrator, worktree, email],
    snapshot,
  };
});

export const makePreviewTestHandler = Effect.gen(function* () {
  yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const standard = (yield* PreviewStandardToolkit) as unknown as BuiltToolkit;
  const snapshot = (yield* PreviewSnapshotToolkit) as unknown as BuiltToolkit;
  const runtimeContext = yield* Effect.context<never>();
  return yield* makeScopedPathwayMcpHandler({
    toolkits: [standard],
    snapshot,
    runtimeContext,
  });
}).pipe(
  Effect.provide(
    Layer.mergeAll(PreviewStandardToolkitHandlersLive, PreviewSnapshotToolkitHandlersLive),
  ),
);

export const makeOrchestratorTestHandler = Effect.gen(function* () {
  yield* OrchestratorMcpService.OrchestratorMcpService;
  const toolkit = (yield* OrchestratorToolkit) as unknown as BuiltToolkit;
  const runtimeContext = yield* Effect.context<never>();
  return yield* makeScopedPathwayMcpHandler({ toolkits: [toolkit], runtimeContext });
}).pipe(
  Effect.provide(Layer.mergeAll(OrchestratorToolkitHandlersLive, OrchestratorMcpService.layer)),
);

export const makeCoreToolkitsTestHandler = Effect.gen(function* () {
  yield* PreviewAutomationBroker.PreviewAutomationBroker;
  yield* OrchestratorMcpService.OrchestratorMcpService;
  yield* WorktreeMcpService.WorktreeMcpService;
  const preview = (yield* PreviewStandardToolkit) as unknown as BuiltToolkit;
  const orchestrator = (yield* OrchestratorToolkit) as unknown as BuiltToolkit;
  const worktree = (yield* WorktreeToolkit) as unknown as BuiltToolkit;
  const runtimeContext = yield* Effect.context<never>();
  return yield* makeScopedPathwayMcpHandler({
    toolkits: [preview, orchestrator, worktree],
    runtimeContext,
  });
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      PreviewStandardToolkitHandlersLive,
      OrchestratorToolkitHandlersLive,
      WorktreeToolkitHandlersLive,
      OrchestratorMcpService.layer,
      WorktreeMcpService.layer,
    ),
  ),
);

export const makeAllToolkitsTestHandler = Effect.gen(function* () {
  const { snapshot, toolkits } = yield* buildPathwayMcpToolkits;
  const runtimeContext = yield* Effect.context<never>();
  return yield* makeScopedPathwayMcpHandler({ toolkits, snapshot, runtimeContext });
}).pipe(Effect.provide(ToolkitHandlersLive));

export const makeEmailTestHandler = (projects: ReadonlyArray<EmailProjectSettings> = []) =>
  Effect.gen(function* () {
    const emailService = yield* EmailMcpService.EmailMcpService;
    const emailStore = yield* EmailStoreLive.EmailStore;
    const toolkit = (yield* EmailToolkit) as unknown as BuiltToolkit;
    const runtimeContext = yield* Effect.context<never>();
    const handler = yield* makeScopedPathwayMcpHandler({
      toolkits: [toolkit],
      email: emailService,
      projects,
      runtimeContext,
    });
    const stored = yield* emailStore.subscribeStored;
    yield* Stream.runForEach(stored, (message) =>
      message.attribution.mailSlug === null
        ? Effect.void
        : Effect.sync(() =>
            handler.notify.resourceUpdated(`email://project/${message.attribution.mailSlug}/inbox`),
          ),
    ).pipe(Effect.forkScoped);
    return handler;
  }).pipe(Effect.provide(EmailToolkitHandlersLive));

class McpV2HttpHandler extends Context.Service<McpV2HttpHandler, PathwayMcpHandler>()(
  "@spiritdevs/pathway/mcp/McpHttpServer/McpV2HttpHandler",
) {}

const McpV2HttpHandlerLive = Layer.effect(
  McpV2HttpHandler,
  Effect.gen(function* () {
    yield* PreviewAutomationBroker.PreviewAutomationBroker;
    yield* OrchestratorMcpService.OrchestratorMcpService;
    yield* WorktreeMcpService.WorktreeMcpService;
    yield* IssueTrackerService;
    yield* ProjectionProjectRepository;
    const { snapshot, toolkits } = yield* buildPathwayMcpToolkits;
    const emailService = yield* EmailMcpService.EmailMcpService;
    const emailStore = yield* EmailStoreLive.EmailStore;
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const runtimeContext = yield* Effect.context<never>();
    const handler = makePathwayMcpHandler({
      toolkits,
      snapshot,
      issueAttachmentContext: Context.make(ServerConfig.ServerConfig, serverConfig).pipe(
        Context.add(FileSystem.FileSystem, fileSystem),
      ),
      email: emailService,
      projects: settings.emailCapture.projects,
      runtimeContext,
    });
    const stored = yield* emailStore.subscribeStored;
    yield* Stream.runForEach(stored, (message) =>
      message.attribution.mailSlug === null
        ? Effect.void
        : Effect.sync(() =>
            handler.notify.resourceUpdated(`email://project/${message.attribution.mailSlug}/inbox`),
          ),
    ).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() => Effect.promise(() => handler.close()).pipe(Effect.orDie));
    return handler;
  }),
).pipe(Layer.provide(ToolkitHandlersLive), Layer.provideMerge(McpToolkitServicesLive));

const McpRouteLive = Layer.unwrap(
  Effect.map(McpV2HttpHandler, (handler) =>
    HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        return HttpServerResponse.fromWeb(
          yield* Effect.promise(() => handler.fetch(webRequest, invocation)),
        );
      }),
    ),
  ),
).pipe(Layer.provide(McpV2HttpHandlerLive), Layer.provide(McpAuthMiddlewareLive));

/** Production shares these services with SMTP capture so task notifications use one PubSub. */
export const layerWithSharedEmailPersistence = McpRouteLive;

/** Self-contained variant retained for isolated MCP registration tests. */
export const layer = layerWithSharedEmailPersistence.pipe(
  Layer.provideMerge(EmailStoreLive.layer),
  Layer.provideMerge(EmailWaitStoreLive.layer),
);
