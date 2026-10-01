import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  SimBuildStartInput,
  SimBuildRpcs,
  SIM_BUILD_WS_METHODS,
  SimBuildLogChunk,
  SimBuildError,
} from "./simBuild.ts";
const decodeStart = Schema.decodeUnknownSync(SimBuildStartInput);
const decodeLog = Schema.decodeUnknownSync(SimBuildLogChunk);
const decodeError = Schema.decodeUnknownSync(SimBuildError);
const input = {
  environmentId: "env",
  projectId: "project",
  threadId: "thread",
  action: "run",
  requestId: "retry-key",
  hostId: "local",
  deviceId: "udid",
  containerPath: "ios/App.xcworkspace",
  scheme: "App",
};
it("requires an explicit environment, project, thread and destination", () => {
  expect(decodeStart(input)).toEqual(input);
  for (const field of ["environmentId", "projectId", "threadId", "hostId", "deviceId"]) {
    const invalid = { ...input, [field]: undefined };
    expect(() => decodeStart(invalid)).toThrow();
  }
});
it("rejects command-like options and oversized log chunks at the wire boundary", () => {
  for (const scheme of ["-alltargets", "App\nother", "App\0other"])
    expect(() => decodeStart({ ...input, scheme })).toThrow();
  expect(() =>
    decodeLog({
      sequence: 1,
      text: "x".repeat(16385),
      diagnostics: [],
    }),
  ).toThrow();
});
it("publishes the complete UI RPC group", () => {
  expect([...SimBuildRpcs.requests.keys()].sort()).toEqual(
    Object.values(SIM_BUILD_WS_METHODS).sort(),
  );
});
it("describes retries whose job history has been pruned", () => {
  expect(
    decodeError({ _tag: "SimBuildError", code: "history-pruned", message: "Already accepted." })
      .code,
  ).toBe("history-pruned");
});
