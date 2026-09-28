import { expect, it } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type DeviceServiceState,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import { DeviceService } from "../../../device/DeviceService.ts";
import { ServerSettingsService, layerTest } from "../../../serverSettings.ts";
import { makeAllToolkitsTestHandler } from "../../McpHttpServer.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

const device = {
  hostId: "local",
  id: "test-device",
  platform: "ios" as const,
  name: "Test phone",
  version: "27",
  booted: true,
  physical: false,
};
const state: DeviceServiceState = {
  hosts: [],
  hostStatuses: {},
  hostStatus: "ready",
  devices: [device],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 0,
};
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  threadId: ThreadId.make("test"),
  providerSessionId: "test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(["device"]),
  issuedAt: 1,
};

it.effect(
  "enforces current consent on every tool call and returns screenshots as image blocks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reads = 0;
        const png = new Uint8Array(24);
        const view = new DataView(png.buffer);
        view.setUint32(0, 0x89504e47);
        view.setUint32(4, 0x0d0a1a0a);
        view.setUint32(12, 0x49484452);
        view.setUint32(16, 10);
        view.setUint32(20, 20);
        const unexpected = () => Effect.die(new Error("Unexpected device operation"));
        const service = DeviceService.of({
          agentCli: unexpected(),
          testHost: unexpected,
          agentTarget: unexpected,
          state: Effect.succeed(state),
          subscribe: unexpected(),
          configure: unexpected,
          open: unexpected,
          close: unexpected,
          shutdown: unexpected,
          detail: unexpected,
          action: unexpected,
          readiness: unexpected,
          readinessIfSupported: unexpected,
          agentReadinessIfSupported: unexpected,
          currentReadiness: unexpected,
          list: Effect.sync(() => {
            reads++;
            return state;
          }),
          sessionsForThread: () =>
            Effect.succeed([
              {
                threadId: invocation.threadId,
                hostId: "local",
                deviceId: device.id,
                platform: "ios" as const,
                openedAt: "now",
              },
            ]),
          screenshot: () => Effect.succeed({ device, png }),
        });
        const handler = yield* makeAllToolkitsTestHandler.pipe(
          Effect.provideService(DeviceService, service),
        );
        const client = new Client(
          { name: "device-test", version: "1.0.0" },
          { capabilities: {}, versionNegotiation: { mode: "legacy" } },
        );
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await client.connect(
              new StreamableHTTPClientTransport(new URL("http://device.test/mcp"), {
                fetch: (input, init) =>
                  handler.fetch(
                    new Request(typeof input === "string" ? input : input.href, init),
                    invocation,
                  ),
              }),
            );
            return client;
          }),
          (client) => Effect.promise(() => client.close()).pipe(Effect.orDie),
        );
        for (const name of ["device_list", "device_open", "device_close", "device_screenshot"]) {
          const denied = yield* Effect.promise(() => client.callTool({ name, arguments: {} }));
          expect(denied.isError).toBe(true);
          expect(denied.content).toEqual([
            { type: "text", text: expect.stringContaining("turned off") },
          ]);
        }
        expect(reads).toBe(0);
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        });
        const listed = yield* Effect.promise(() =>
          client.callTool({ name: "device_list", arguments: {} }),
        );
        expect(listed.isError).toBe(false);
        expect(reads).toBe(1);
        const shot = yield* Effect.promise(() =>
          client.callTool({ name: "device_screenshot", arguments: {} }),
        );
        expect(shot.isError).toBe(false);
        expect(shot.content).toContainEqual({
          type: "image",
          mimeType: "image/png",
          data: Buffer.from(png).toString("base64"),
        });
        expect(shot.structuredContent).toEqual({
          device,
          screenshot: { mimeType: "image/png", width: 10, height: 20 },
        });
        yield* settings.updateSettings({ enableAgentDeviceAccess: false });
        const revoked = yield* Effect.promise(() =>
          client.callTool({ name: "device_list", arguments: {} }),
        );
        expect(revoked.isError).toBe(true);
        expect(reads).toBe(1);
      }),
    ).pipe(Effect.provide(layerTest())),
);
