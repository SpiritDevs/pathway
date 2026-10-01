import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ThreadId, RunId } from "@spiritdevs/contracts";
import { AgentDeviceRequest, prepareAgentDeviceRequest } from "./DeviceAgentGateway.ts";
const decodeRequest = Schema.decodeUnknownEffect(AgentDeviceRequest);
const access = {
  grant: {
    hostId: "local",
    deviceId: "phone",
    generation: 1,
    owner: { kind: "agent" as const, threadId: ThreadId.make("thread"), runId: RunId.make("run") },
  },
  session: "bound-session",
  platform: "ios" as const,
};
const payload = {
  jsonrpc: "2.0",
  id: "request",
  method: "agent_device.command",
  params: {
    session: "bound-session",
    command: "snapshot",
    positionals: [],
    flags: {
      stateDir: "/private",
      daemonBaseUrl: "http://gateway",
      platform: "ios",
      udid: "phone",
      snapshotInteractiveOnly: true,
      verbose: false,
      session: "bound-session",
    },
    meta: { requestProgress: "command" },
    token: "gateway-grant",
  },
};
it.effect(
  "accepts the pinned CLI request while stripping credentials, transport flags and progress streaming",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeRequest(payload);
      const request = yield* prepareAgentDeviceRequest(decoded, access);
      expect(request.params).toEqual({
        session: "bound-session",
        command: "snapshot",
        positionals: [],
        flags: { platform: "ios", udid: "phone", snapshotInteractiveOnly: true, verbose: false },
      });
    }),
);
it.effect("rejects other targets, sessions, background commands and selectors", () =>
  Effect.gen(function* () {
    const base = yield* decodeRequest(payload);
    for (const params of [
      { ...base.params, session: "other" },
      { ...base.params, command: "replay" },
      { ...base.params, flags: { ...base.params.flags, udid: "other" } },
      { ...base.params, flags: { ...base.params.flags, serial: "android" } },
      { ...base.params, flags: { ...base.params.flags, all: true } },
    ])
      expect(
        (yield* prepareAgentDeviceRequest({ ...base, params }, access).pipe(Effect.flip)).code,
      ).toBe("invalid_grant");
  }),
);
