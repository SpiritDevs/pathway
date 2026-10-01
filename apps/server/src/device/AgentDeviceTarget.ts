import { processIdentity } from "./deviceMachineLock.ts";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { AgentDeviceEndpoint } from "./DeviceHost.ts";

const encodeEndpoint = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ daemonBaseUrl: Schema.String, daemonAuthToken: Schema.String }),
  ),
);

const key = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 24);

/** A stable file per host lets forwarded endpoints change without retargeting other commands. */
export const agentDeviceConfigPath = (stateDir: string, hostId: string, path: Path.Path) =>
  path.join(stateDir, "device", "hosts", `${key(hostId)}.json`);

export const agentDeviceSession = (threadId: string, hostId: string, deviceId: string) =>
  `pathway-${key(JSON.stringify([threadId, hostId, deviceId]))}`;

export const writeAgentDeviceConfig = Effect.fn("AgentDeviceTarget.writeConfig")(function* (
  file: string,
  endpoint: Pick<AgentDeviceEndpoint, "baseUrl" | "token"> & { readonly entryPath?: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const content = yield* encodeEndpoint({
    daemonBaseUrl: endpoint.baseUrl,
    daemonAuthToken: endpoint.token,
  });
  if ((yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))) === content) return;
  const temporary = yield* fs.makeTempFile({ directory: path.dirname(file), prefix: ".endpoint-" });
  yield* Effect.gen(function* () {
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, content);
    yield* fs.rename(temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});

const AgentTargetGrant = Schema.Struct({
  configPath: Schema.String,
  endpoint: Schema.String,
  deviceId: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  serverPid: Schema.Int,
  serverIdentity: Schema.String,
});

const encodeGrant = Schema.encodeEffect(Schema.fromJsonString(AgentTargetGrant));

/** Bind the CLI's target flags to the simulator whose lease device_open acquired. */
export const writeAgentDeviceTargetGrant = Effect.fn("AgentDeviceTarget.writeGrant")(function* (
  stateDir: string,
  session: string,
  target: { configPath: string; deviceId: string; platform: "ios" | "android" },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, "device", "targets");
  yield* fs.makeDirectory(directory, { recursive: true });
  const endpoint = yield* fs.readFileString(target.configPath);
  const content = yield* encodeGrant({
    ...target,
    endpoint,
    serverPid: process.pid,
    serverIdentity: processIdentity(process.pid) ?? "unknown",
  });
  yield* fs.writeFileString(path.join(directory, session + ".json"), content, { mode: 0o600 });
});
