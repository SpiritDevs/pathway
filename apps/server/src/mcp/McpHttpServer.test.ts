import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { PATHWAY_MCP_TOOL_NAMES } from "./PathwayMcpToolCatalog.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation: McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ErrorResponse = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
const ErrorCodeResponse = Schema.Struct({ error: Schema.Struct({ code: Schema.Number }) });
const SseMessage = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.String,
    params: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponse);
const decodeErrorCodeResponse = Schema.decodeUnknownEffect(ErrorCodeResponse);
const decodeSseMessage = Schema.decodeUnknownSync(SseMessage);
const toWebRequest = (input: string | URL, init?: RequestInit) =>
  new Request(typeof input === "string" ? input : input.href, init);

const connectClient = async (
  handler: McpHttpServer.PathwayMcpHandler,
  protocolVersion = McpHttpServer.MCP_PROTOCOL_VERSION,
) => {
  const client = new Client(
    { name: "pathway-mcp-test", version: "1.0.0" },
    protocolVersion >= "2026-07-28"
      ? { capabilities: {}, versionNegotiation: { mode: { pin: protocolVersion } } }
      : {
          capabilities: {},
          supportedProtocolVersions: [protocolVersion],
          versionNegotiation: { mode: "legacy" },
        },
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://pathway.test/mcp"), {
    fetch: (input, init) => handler.fetch(toWebRequest(input, init), invocation),
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
};

const rawRequest = (
  method: string,
  params: Record<string, unknown>,
  options: {
    readonly version?: string;
    readonly headerVersion?: string;
    readonly name?: string;
  } = {},
) => {
  const version = options.version ?? McpHttpServer.MCP_PROTOCOL_VERSION;
  return new Request("http://pathway.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": options.headerVersion ?? version,
      "mcp-method": method,
      ...(options.name === undefined ? {} : { "mcp-name": options.name }),
    },
    body: encodeJson({
      jsonrpc: "2.0",
      id: "raw:1",
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: version,
          [CLIENT_INFO_META_KEY]: { name: "pathway-raw-test", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
};

const readSseMessage = async (reader: {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
}) => {
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("SSE stream closed before a message arrived.");
    if (next.value !== undefined) buffered += decoder.decode(next.value, { stream: true });
  }
  const data = buffered
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (data === undefined) throw new Error("SSE frame did not contain data.");
  return decodeSseMessage(data);
};

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("serves discover and all preview tools through the v2 client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const handler = yield* McpHttpServer.makePreviewTestHandler;
      const routedRequests: Array<{ readonly operation: string; readonly tabId?: string }> = [];
      const events = yield* broker.connect({ clientId: "mcp-test-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push({
          operation: event.request.operation,
          ...(event.request.tabId === undefined ? {} : { tabId: event.request.tabId }),
        });
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const connected = yield* Effect.acquireRelease(
        Effect.promise(() => connectClient(handler)),
        ({ close }) => Effect.promise(close).pipe(Effect.orDie),
      );
      const discover = yield* Effect.promise(() => connected.client.discover());
      expect(discover.supportedVersions).toEqual([McpHttpServer.MCP_PROTOCOL_VERSION]);
      expect(McpHttpServer.PATHWAY_MCP_SERVER_INFO.name).toBe("Pathway");
      expect(discover.instructions).toContain("authenticated coding-agent thread");
      expect(discover.capabilities.tools).toBeDefined();

      const listed = yield* Effect.promise(() => connected.client.listTools());
      const statusTool = listed.tools.find(({ name }) => name === "preview_status");
      expect(statusTool?.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.annotations?.destructiveHint).toBe(false);

      const snapshotTool = listed.tools.find(({ name }) => name === "preview_snapshot");
      expect(snapshotTool?.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.annotations?.openWorldHint).toBe(true);

      const clickTool = listed.tools.find(({ name }) => name === "preview_click");
      expect(clickTool?.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.annotations?.openWorldHint).toBe(true);

      const navigateTool = listed.tools.find(({ name }) => name === "preview_navigate");
      expect(navigateTool?.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.annotations?.openWorldHint).toBe(true);

      const status = yield* Effect.promise(() =>
        connected.client.callTool({ name: "preview_status", arguments: {} }),
      );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({ available: true, tabId });

      const malformedRejected = yield* Effect.promise(() =>
        connected.client.callTool({ name: "preview_click", arguments: { selector: "" } }),
      );
      expect(malformedRejected.isError).toBe(true);

      const snapshot = yield* Effect.promise(() =>
        connected.client.callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId },
        }),
      );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* Effect.promise(() =>
        connected.client.callTool({ name: "preview_press", arguments: { key: "Enter" } }),
      );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("serves every production Pathway toolkit through one endpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* McpHttpServer.makeAllToolkitsTestHandler;
      const connected = yield* Effect.acquireRelease(
        Effect.promise(() => connectClient(handler)),
        ({ close }) => Effect.promise(close).pipe(Effect.orDie),
      );
      const listed = yield* Effect.promise(() => connected.client.listTools());
      const actual = listed.tools.map(({ name }) => name).sort();
      const expected = [...PATHWAY_MCP_TOOL_NAMES].sort();

      expect(expected).toHaveLength(43);
      expect(new Set(expected).size).toBe(expected.length);
      expect(actual).toEqual(expected);
      expect(actual).toContain("issues_get");
      expect(actual).toContain("issues_update");
      expect(actual).toContain("issues_comment");
    }),
  ),
);

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const handler = yield* McpHttpServer.makePreviewTestHandler;
      const events = yield* broker.connect({ clientId: "mcp-failure-client", environmentId });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const connected = yield* Effect.acquireRelease(
        Effect.promise(() => connectClient(handler)),
        ({ close }) => Effect.promise(close).pipe(Effect.orDie),
      );
      const snapshot = yield* Effect.promise(() =>
        connected.client.callTool({ name: "preview_snapshot", arguments: {} }),
      );
      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("rejects invalid modern envelopes with the specified HTTP errors", () =>
  Effect.gen(function* () {
    const handler = yield* McpHttpServer.makePreviewTestHandler;

    const mismatch = yield* Effect.promise(() =>
      handler.fetch(
        rawRequest("server/discover", {}, { headerVersion: "2026-07-28", version: "2099-01-01" }),
        invocation,
      ),
    );
    expect(mismatch.status).toBe(400);
    expect(
      (yield* decodeErrorCodeResponse(yield* Effect.promise(() => mismatch.json()))).error.code,
    ).toBe(-32020);

    const missingMeta = yield* Effect.promise(() =>
      handler.fetch(
        new Request("http://pathway.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": McpHttpServer.MCP_PROTOCOL_VERSION,
            "mcp-method": "server/discover",
          },
          body: encodeJson({ jsonrpc: "2.0", id: 2, method: "server/discover", params: {} }),
        }),
        invocation,
      ),
    );
    const missingMetaBody = yield* decodeErrorResponse(
      yield* Effect.promise(() => missingMeta.json()),
    );
    expect(missingMetaBody.error.code).toBe(-32602);

    const unsupported = yield* Effect.promise(() =>
      handler.fetch(rawRequest("server/discover", {}, { version: "2099-01-01" }), invocation),
    );
    const unsupportedBody = yield* decodeErrorResponse(
      yield* Effect.promise(() => unsupported.json()),
    );
    expect(unsupportedBody.error.code).toBe(-32022);
    expect(unsupportedBody.error.data?.supported).toEqual([McpHttpServer.MCP_PROTOCOL_VERSION]);
  }).pipe(Effect.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("serves issue tools through Codex's legacy MCP handshake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* McpHttpServer.makeAllToolkitsTestHandler;
      const connected = yield* Effect.acquireRelease(
        Effect.promise(() => connectClient(handler, "2025-06-18")),
        ({ close }) => Effect.promise(close).pipe(Effect.orDie),
      );
      const tools = yield* Effect.promise(() => connected.client.listTools());
      const toolNames = tools.tools.map(({ name }) => name);
      expect(toolNames).toContain("issues_get");
      expect(toolNames).toContain("issues_update");
      expect(toolNames).toContain("issues_comment");
    }),
  ),
);

it.effect("acknowledges listen first and emits only opted-in notification types", () =>
  Effect.gen(function* () {
    const handler = yield* McpHttpServer.makePreviewTestHandler;
    const response = yield* Effect.promise(() =>
      handler.fetch(
        rawRequest("subscriptions/listen", {
          notifications: { toolsListChanged: true, resourcesListChanged: false },
        }),
        invocation,
      ),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const acknowledged = yield* Effect.promise(() => readSseMessage(reader));
    expect(acknowledged.method).toBe("notifications/subscriptions/acknowledged");

    handler.notify.resourcesChanged();
    handler.notify.toolsChanged();
    const notification = yield* Effect.promise(() => readSseMessage(reader));
    expect(notification.method).toBe("notifications/tools/list_changed");
    yield* Effect.promise(() => reader.cancel());
  }).pipe(Effect.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("delivers listen notifications through the v2 client subscription", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* McpHttpServer.makePreviewTestHandler;
      const connected = yield* Effect.acquireRelease(
        Effect.promise(() => connectClient(handler)),
        ({ close }) => Effect.promise(close).pipe(Effect.orDie),
      );
      let markNotificationReceived: () => void = () => undefined;
      const notificationReceived = new Promise<void>((resolve) => {
        markNotificationReceived = resolve;
      });
      connected.client.setNotificationHandler("notifications/tools/list_changed", () => {
        markNotificationReceived();
      });

      const subscription = yield* Effect.acquireRelease(
        Effect.promise(() => connected.client.listen({ toolsListChanged: true })),
        (openSubscription) => Effect.promise(() => openSubscription.close()).pipe(Effect.orDie),
      );
      expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });

      handler.notify.toolsChanged();
      yield* Effect.promise(() => notificationReceived);
    }),
  ).pipe(Effect.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)))),
);
