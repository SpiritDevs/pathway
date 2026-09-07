// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";
import * as NodeURL from "node:url";

import {
  DesktopHostTelemetryMessage,
  DesktopTelemetryControlMessage,
  type DesktopUpdateState,
} from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const encodeReport = Schema.encodeSync(Schema.fromJsonString(DesktopHostTelemetryMessage));
const decodeControl = Schema.decodeUnknownSync(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);
const serverDirectory = NodeURL.fileURLToPath(new URL("../../", import.meta.url));

const childProgram = `
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "./src/config.ts";
import * as Receiver from "./src/resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as Update from "./src/desktopUpdate/DesktopAppUpdate.ts";
import * as Settings from "./src/serverSettings.ts";

const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const base = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), process.argv[1])),
  );
  const config = { ...base, mode: "desktop", desktopTelemetryFd: 3, desktopTelemetryControlFd: 4 };
  const receiver = yield* Receiver.make().pipe(Effect.provideService(ServerConfig.ServerConfig, config), Effect.provide(Settings.layerTest()));
  const service = yield* Update.make().pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(Receiver.DesktopTelemetryReceiver, receiver),
  );
  if (process.argv[2]) {
    const failure = yield* service.commit(process.argv[2]).pipe(Effect.flip);
    return { failure: failure.reason };
  }
  const stages = [];
  return yield* service.run(stage => Effect.sync(() => { stages.push(stage); })).pipe(
    Effect.match({
      onFailure: failure => ({ failure: failure.reason }),
      onSuccess: prepared => ({ prepared, stages }),
    }),
  );
})).pipe(Effect.provide(NodeServices.layer)));
process.stdout.write(JSON.stringify(result) + "\\n");
`;

const downloadedState: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.2.3",
  availableVersion: "1.2.4",
  downloadedVersion: "1.2.4",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  releaseNotes: [],
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

/** Runs the real server services with the inherited pipes used by the desktop backend. */
async function runBackend(
  baseDir: string,
  onControl: (
    message: DesktopTelemetryControlMessage,
    report: (value: DesktopHostTelemetryMessage) => void,
    end: (chunk?: string) => void,
  ) => void,
  token?: string,
) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "-e", childProgram, baseDir, ...(token ? [token] : [])],
    {
      cwd: serverDirectory,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
  const reports = child.stdio[3] as NodeStream.Writable;
  const controls = NodeReadline.createInterface({ input: child.stdio[4] as NodeStream.Readable });
  let stdout = "";
  let stderr = "";
  let controlError: unknown;
  child.stdout!.on("data", (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  controls.on("line", (line) => {
    try {
      onControl(
        decodeControl(line),
        (value) => {
          reports.write(`${encodeReport(value)}\n`);
        },
        (chunk) => reports.end(chunk),
      );
    } catch (error) {
      controlError = error;
      child.kill();
    }
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (controlError) throw controlError;
    expect(code, stderr).toBe(0);
    const result = stdout.split("\n").find((line) => line.startsWith("{"));
    expect(result, stdout).toBeDefined();
    return JSON.parse(result!) as {
      prepared?: { targetVersion: string; method: string; desktopUpdateToken: string };
      stages?: string[];
      failure?: string;
    };
  } finally {
    controls.close();
    reports.destroy();
    if (child.exitCode === null) child.kill();
  }
}

it("prepares over fd3/fd4 and receives retained install failures after a backend restart", async () => {
  const baseDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "pathway-desktop-update-transport-"),
  );
  try {
    const controls: string[] = [];
    const result = await runBackend(baseDir, (message, report, end) => {
      controls.push(message.type);
      if (message.type !== "requestDesktopUpdate") return;
      report({
        version: 1,
        type: "desktopUpdateStatus",
        requestId: "another-request",
        outcome: "failed",
        state: downloadedState,
        reason: "Unrelated failure",
      });
      report({
        version: 1,
        type: "desktopUpdateStatus",
        requestId: message.requestId,
        state: { ...downloadedState, status: "checking" },
      });
      report({
        version: 1,
        type: "desktopUpdateStatus",
        requestId: message.requestId,
        state: { ...downloadedState, status: "downloading" },
      });
      report({
        version: 1,
        type: "desktopUpdateStatus",
        requestId: message.requestId,
        state: downloadedState,
        outcome: "ready-to-install",
      });
      end();
    });
    expect(result.prepared).toEqual({
      method: "desktop-app",
      targetVersion: "1.2.4",
      desktopUpdateToken: expect.any(String),
    });
    expect(result.stages).toEqual(["checking", "downloading", "installing"]);
    expect(controls).not.toContain("commitDesktopUpdate");

    const token = result.prepared!.desktopUpdateToken;
    const restarted = await runBackend(
      baseDir,
      (message, report, end) => {
        if (message.type !== "commitDesktopUpdate") return;
        expect(message.requestId).toBe(token);
        report({
          version: 1,
          type: "desktopUpdateStatus",
          requestId: token,
          state: { ...downloadedState, errorContext: "install", canRetry: true },
          outcome: "failed",
          reason: "Installer failed; backend restored",
        });
        end();
      },
      token,
    );
    expect(restarted.failure).toBe("Installer failed; backend restored");
  } finally {
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
}, 20_000);

it.each([
  { phase: "preparation", finalChunk: "", token: undefined },
  { phase: "preparation", finalChunk: "not-json\n", token: undefined },
  { phase: "installation", finalChunk: "", token: "prepared-update-token" },
  { phase: "installation", finalChunk: "not-json\n", token: "prepared-update-token" },
])(
  "fails promptly when the report transport closes during $phase ($finalChunk)",
  async ({ finalChunk, token }) => {
    const baseDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "pathway-desktop-update-transport-loss-"),
    );
    try {
      const result = await runBackend(
        baseDir,
        (message, report, end) => {
          if (message.type !== "requestDesktopUpdate" && message.type !== "commitDesktopUpdate") {
            return;
          }
          report({
            version: 1,
            type: "desktopUpdateStatus",
            requestId: message.requestId,
            state: { ...downloadedState, status: "checking" },
          });
          end(finalChunk);
        },
        token,
      );
      expect(result.failure).toBe(
        token
          ? "The desktop app stopped reporting the install."
          : "The desktop app stopped reporting its update.",
      );
    } finally {
      await NodeFSP.rm(baseDir, { recursive: true, force: true });
    }
  },
  20_000,
);
