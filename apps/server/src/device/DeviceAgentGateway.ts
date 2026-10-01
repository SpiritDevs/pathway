import { Effect, Schema, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { DeviceService } from "./DeviceService.ts";
import { controlError, type DeviceControlGrant } from "./DeviceControl.ts";

export const AgentDeviceRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.Literal("agent_device.command"),
  params: Schema.Struct({
    command: Schema.String,
    session: Schema.String,
    positionals: Schema.optional(Schema.Array(Schema.String)),
    flags: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
// Commands returning before a background input job finishes are deliberately absent.
const COMMANDS = new Set([
  "open",
  "close",
  "snapshot",
  "screenshot",
  "click",
  "tap",
  "fill",
  "type",
  "press",
  "swipe",
  "scroll",
  "back",
  "wait",
  "find",
  "get",
  "is",
  "install",
  "uninstall",
  "keyboard",
  "appstate",
]);
const TRANSPORT_FLAGS = new Set([
  "stateDir",
  "daemonBaseUrl",
  "daemonAuthToken",
  "session",
  "config",
]);
const FLAGS = new Set([
  "snapshotInteractiveOnly",
  "snapshotDepth",
  "snapshotCompact",
  "snapshotRaw",
  "platform",
  "udid",
  "serial",
  "interactive",
  "json",
  "depth",
  "compact",
  "raw",
  "timeout",
  "format",
  "quality",
  "width",
  "height",
  "duration",
  "direction",
  "count",
  "clear",
  "key",
  "text",
  "x",
  "y",
  "save",
  "output",
  "verbose",
]);
export const prepareAgentDeviceRequest = Effect.fn("DeviceAgentGateway.prepare")(function* (
  body: typeof AgentDeviceRequest.Type,
  access: { grant: DeviceControlGrant; session: string; platform: "ios" | "android" },
) {
  const flags = Object.fromEntries(
    Object.entries(body.params.flags ?? {}).filter(([key]) => !TRANSPORT_FLAGS.has(key)),
  );
  if (
    body.params.session !== access.session ||
    !COMMANDS.has(body.params.command) ||
    Object.keys(flags).some((flag) => !FLAGS.has(flag)) ||
    flags.platform !== access.platform ||
    flags[access.platform === "ios" ? "udid" : "serial"] !== access.grant.deviceId ||
    flags[access.platform === "ios" ? "serial" : "udid"] !== undefined
  )
    return yield* controlError(access.grant, "invalid_grant");
  return { ...body, params: { ...body.params, flags } };
});

const commandRouteLayer = HttpRouter.add(
  "POST",
  "/api/device-agent/rpc",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const body = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AgentDeviceRequest)),
      Effect.result,
    );
    if (body._tag === "Failure")
      return HttpServerResponse.text("Invalid device command", { status: 400 });
    const service = yield* DeviceService;
    const result = yield* service.agentCommand(token, body.success).pipe(Effect.result);
    if (result._tag === "Failure")
      return yield* HttpServerResponse.json(
        {
          jsonrpc: "2.0",
          id: body.success.id,
          error: { code: -32000, message: result.failure.message, data: result.failure },
        },
        { status: 409 },
      );
    return yield* HttpServerResponse.json(result.success);
  }),
);

export const deviceAgentGatewayRouteLayer = Layer.merge(
  commandRouteLayer,
  HttpRouter.add(
    "GET",
    "/api/device-agent/health",
    HttpServerResponse.json({
      service: "pathway-device-gateway",
      version: "0.21.12",
      rpcProtocolVersion: 2,
    }),
  ),
);
