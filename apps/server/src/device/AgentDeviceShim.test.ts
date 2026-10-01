// @effect-diagnostics nodeBuiltinImport:off - verifies the emitted CLI with a harmless stand-in executable.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { ThreadId } from "@spiritdevs/contracts";
import { ensureAgentDeviceShim } from "./AgentDeviceShim.ts";
import { agentDeviceSession, writeAgentDeviceTargetGrant } from "./AgentDeviceTarget.ts";

it.effect("only drives the granted simulator and rejects a stale daemon connection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-device-shim-" });
    const entryPath = `${stateDir}/fake-agent.mjs`;
    yield* fs.writeFileString(entryPath, 'console.log("ran");');
    const configPath = `${stateDir}/config.json`;
    yield* fs.writeFileString(configPath, '{"daemonAuthToken":"test"}');
    const directory = yield* ensureAgentDeviceShim({ stateDir, entryPath });
    const session = agentDeviceSession(ThreadId.make("test"), "local", "phone");
    const args = [
      "open",
      "--config",
      configPath,
      "--session",
      session,
      "--platform",
      "ios",
      "--udid",
      "phone",
    ];
    const run = (values: string[]) =>
      NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
        `${directory}/agent-device-launcher.mjs`,
        ...values,
      ]);
    yield* Effect.promise(() => expect(run(args)).rejects.toThrow("Call device_open again"));
    yield* writeAgentDeviceTargetGrant(stateDir, session, {
      configPath,
      deviceId: "phone",
      platform: "ios",
    });
    expect((yield* Effect.promise(() => run(args))).stdout.trim()).toBe("ran");
    yield* Effect.promise(() =>
      expect(run([...args.slice(0, -1), "someone-elses-phone"])).rejects.toThrow(
        "Call device_open again",
      ),
    );
    yield* fs.writeFileString(configPath, '{"daemonAuthToken":"restarted"}');
    yield* Effect.promise(() => expect(run(args)).rejects.toThrow("Call device_open again"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
