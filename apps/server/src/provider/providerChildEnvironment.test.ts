// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as AcpSessionRuntime from "./acp/AcpSessionRuntime.ts";
import {
  mergeProviderInstanceEnvironment,
  providerChildEnvironment,
} from "./ProviderInstanceEnvironment.ts";

const hostKeys = ["PATHWAY_BROWSER_HOST_CAPABILITY_SPAWN_TEST", "PATHWAY_CUA_SPAWN_TEST"] as const;

/** Puts Computer host keys in the server's own environment until the test's scope closes. */
const withComputerHostKeysInProcessEnv = Effect.acquireRelease(
  Effect.sync(() => {
    for (const key of hostKeys) process.env[key] = "host-only";
  }),
  () =>
    Effect.sync(() => {
      for (const key of hostKeys) delete process.env[key];
    }),
);

const decodeObservedEnv = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const instanceEnvironment = () =>
  mergeProviderInstanceEnvironment([
    { name: "PATHWAY_SPAWN_TEST_INSTANCE", value: "instance", sensitive: false },
  ]);

const expectProviderChildEnv = (observed: Record<string, string>, instanceVar: boolean) => {
  for (const key of hostKeys) expect(observed).not.toHaveProperty(key);
  expect(observed.PATH).toBe(process.env.PATH);
  if (instanceVar) expect(observed.PATHWAY_SPAWN_TEST_INSTANCE).toBe("instance");
};

describe("providerChildEnvironment", () => {
  it.effect("never extends, so the spawner cannot merge stripped keys back in", () =>
    Effect.gen(function* () {
      yield* withComputerHostKeysInProcessEnv;
      const extended = yield* providerChildEnvironment({ env: { EXTRA: "1" }, extendEnv: true });
      expect(extended.extendEnv).toBe(false);
      expect(extended.env.EXTRA).toBe("1");
      expect(extended.env.PATH).toBe(process.env.PATH);
      for (const key of hostKeys) expect(extended.env).not.toHaveProperty(key);

      const replaced = yield* providerChildEnvironment({
        env: { ONLY: "1", PATHWAY_CUA_SPAWN_TEST: "x" },
      });
      expect(replaced).toEqual({ env: { ONLY: "1" }, extendEnv: false });

      const inherited = yield* providerChildEnvironment();
      for (const key of hostKeys) expect(inherited.env).not.toHaveProperty(key);
    }).pipe(Effect.scoped),
  );
});

describe("provider child spawn sites", () => {
  it.effect.each([
    { name: "a merged instance environment", instanceVar: true },
    { name: "no environment", instanceVar: false },
  ])("keeps Computer host keys out of an ACP child given $name", ({ instanceVar }) =>
    Effect.gen(function* () {
      yield* withComputerHostKeysInProcessEnv;
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-acp-env-"))),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      );
      const output = NodePath.join(directory, "env.json");
      const runtime = yield* AcpSessionRuntime.make({
        cwd: directory,
        clientInfo: { name: "pathway-test", version: "0.0.0" },
        spawn: {
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
            output,
          ],
          ...(instanceVar ? { env: instanceEnvironment() } : {}),
        },
      });
      // The child writes its environment and exits, which fails the handshake.
      yield* Effect.exit(runtime.start());

      expectProviderChildEnv(decodeObservedEnv(NodeFS.readFileSync(output, "utf8")), instanceVar);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { name: "an extending environment", instanceVar: true },
    { name: "no environment", instanceVar: false },
  ])("keeps Computer host keys out of a process runner child given $name", ({ instanceVar }) =>
    Effect.gen(function* () {
      yield* withComputerHostKeysInProcessEnv;
      const runner = yield* ProcessRunner.ProcessRunner;
      const result = yield* runner.run({
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        ...(instanceVar ? { env: { PATHWAY_SPAWN_TEST_INSTANCE: "instance" } } : {}),
      });

      expect(result.code).toBe(0);
      expectProviderChildEnv(decodeObservedEnv(result.stdout), instanceVar);
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );
});
