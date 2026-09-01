import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup, WsServerGetProviderUsageRpc } from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("exposes only the V2 orchestration transport surface", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(expect.arrayContaining(Object.values(ORCHESTRATION_V2_WS_METHODS)));
    expect(methods.filter((method) => method.startsWith("orchestrationV1."))).toEqual([]);
  });

  it("exposes issue import preview and execute", () => {
    expect([...WsRpcGroup.requests.keys()]).toEqual(
      expect.arrayContaining([
        WS_METHODS.cloudIssueImportPreview,
        WS_METHODS.cloudIssueImportExecute,
      ]),
    );
  });

  it("exposes the provider usage subscription", () => {
    expect([...WsRpcGroup.requests.keys()]).toContain(WS_METHODS.serverSubscribeProviderUsage);
  });

  it("round-trips provider rate-limit deadlines", () => {
    const decode = Schema.decodeUnknownSync(WsServerGetProviderUsageRpc.successSchema);
    const encode = Schema.encodeUnknownSync(WsServerGetProviderUsageRpc.successSchema);
    const snapshot = decode({
      instanceId: "usage_test",
      provider: "claudeAgent",
      source: "provider-rate-limit",
      updatedAt: "2026-09-01T20:00:00.000Z",
      limits: [],
      usageLines: [],
      status: "error",
      rateLimitedUntil: "2026-09-01T20:05:00.000Z",
    });

    expect(encode(snapshot)).toMatchObject({
      rateLimitedUntil: "2026-09-01T20:05:00.000Z",
    });
  });
});
