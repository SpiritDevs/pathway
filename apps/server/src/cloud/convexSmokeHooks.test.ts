/**
 * CI unit tests for the `cyndr run`-backed smoke hooks: stdout parsing
 * (the CLI may prefix the JSON return value with log lines) and the exact
 * command each hook issues, using a stub `ProcessRunner` so nothing spawns.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  checkConvexSmokeDeploymentTarget,
  makeConvexRunSmokeHooks,
  parseConvexRunOutput,
  type ConvexRunSmokeHooksConfig,
} from "./convexSmokeHooks.ts";
import { ConvexSyncSmokeHookError, type ConvexSyncSmokeHooks } from "./convexSyncSmoke.ts";

describe("parseConvexRunOutput", () => {
  it("parses a bare JSON value", () => {
    const parsed = parseConvexRunOutput('{"companyId":"c-1","registrationId":"r-1"}\n');
    assert.deepEqual(parsed, { ok: true, value: { companyId: "c-1", registrationId: "r-1" } });
  });

  it("parses scalar return values", () => {
    assert.deepEqual(parseConvexRunOutput("null\n"), { ok: true, value: null });
    assert.deepEqual(parseConvexRunOutput("true"), { ok: true, value: true });
  });

  it("strips leading non-JSON log lines", () => {
    const parsed = parseConvexRunOutput(
      ['Preparing "smoke:seed"...', "[LOG] seeding", '{"updated":true}'].join("\n"),
    );
    assert.deepEqual(parsed, { ok: true, value: { updated: true } });
  });

  it("handles pretty-printed multi-line JSON after log lines", () => {
    const parsed = parseConvexRunOutput(["some banner", "{", '  "revoked": true', "}"].join("\n"));
    assert.deepEqual(parsed, { ok: true, value: { revoked: true } });
  });

  it("reports empty and non-JSON stdout", () => {
    assert.isFalse(parseConvexRunOutput("").ok);
    assert.isFalse(parseConvexRunOutput("   \n  ").ok);
    assert.isFalse(parseConvexRunOutput("nothing but logs\nhere").ok);
  });
});

const CONFIG: ConvexRunSmokeHooksConfig = {
  environmentId: "env-smoke-test",
  companyId: "00000000-0000-7000-8000-736d6f6b6501",
  backendDir: "/repo/packages/backend",
  deployment: "pathway-dev",
  convexUrl: "https://pathway-dev.syd.cyndrbase.cloud",
};

function okOutput(stdout: string): ProcessRunner.ProcessRunOutput {
  return {
    stdout,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(0),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}

// JSON canned results / expected argv payloads, prebuilt at module scope (the
// effect language service flags JSON.parse/stringify inside Effect generators).
const SEED_OK_STDOUT = JSON.stringify({
  companyId: CONFIG.companyId,
  registrationId: "r",
  roleId: "x",
});
const SEED_WRONG_COMPANY_STDOUT = JSON.stringify({
  companyId: "some-other-company",
  registrationId: "r",
});
const SEED_EXPECTED_ARGS = JSON.stringify({
  environmentId: "env-smoke-test",
  publicKeyThumbprint: "jkt-1",
});
const SET_THUMBPRINT_EXPECTED_ARGS = JSON.stringify({
  environmentId: "env-smoke-test",
  publicKeyThumbprint: "jkt-2",
});
const ENVIRONMENT_ONLY_EXPECTED_ARGS = JSON.stringify({ environmentId: "env-smoke-test" });
const UPDATED_FALSE_STDOUT = JSON.stringify({ updated: false });
const REVOKED_TRUE_STDOUT = JSON.stringify({ revoked: true });
const CLEANUP_COUNTS_STDOUT = JSON.stringify({ registrations: 0, companies: 0 });

/** Builds the hooks over a stub runner that records every invocation. */
function makeHooksWith(
  respond: (input: ProcessRunner.ProcessRunInput) => ProcessRunner.ProcessRunOutput,
): Effect.Effect<
  {
    readonly hooks: ConvexSyncSmokeHooks;
    readonly calls: Array<ProcessRunner.ProcessRunInput>;
  },
  ConvexSyncSmokeHookError
> {
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const runnerLayer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) => {
        calls.push(input);
        return Effect.succeed(respond(input));
      },
    }),
  );
  return makeConvexRunSmokeHooks(CONFIG).pipe(
    Effect.provide(runnerLayer),
    Effect.map((hooks) => ({ hooks, calls })),
  );
}

describe("checkConvexSmokeDeploymentTarget", () => {
  it("accepts a deployment that is the first hostname label of the deployment URL", () => {
    assert.isNull(
      checkConvexSmokeDeploymentTarget({
        deployment: "pathway-dev",
        convexUrl: "https://pathway-dev.syd.cyndrbase.cloud",
        allowUrlMismatch: false,
      }),
    );
  });

  it("refuses a deployment/hostname mismatch with an actionable message", () => {
    const refusal = checkConvexSmokeDeploymentTarget({
      deployment: "pathway-dev",
      convexUrl: "https://pathway.syd.cyndrbase.cloud",
      allowUrlMismatch: false,
    });
    assert.isNotNull(refusal);
    assert.include(refusal, "pathway-dev");
    assert.include(refusal, "pathway.syd.cyndrbase.cloud");
    assert.include(refusal, "PATHWAY_CYNDRBASE_SMOKE_ALLOW_URL_MISMATCH=1");
  });

  it("lets the operator opt out for custom domains and local engines", () => {
    assert.isNull(
      checkConvexSmokeDeploymentTarget({
        deployment: "pathway-dev",
        convexUrl: "http://127.0.0.1:3210",
        allowUrlMismatch: true,
      }),
    );
  });

  it("refuses a missing deployment and unparseable URLs even with the opt-out", () => {
    assert.include(
      checkConvexSmokeDeploymentTarget({
        deployment: " ",
        convexUrl: "https://pathway-dev.syd.cyndrbase.cloud",
        allowUrlMismatch: true,
      }),
      "PATHWAY_CYNDRBASE_SMOKE_DEPLOYMENT",
    );
    assert.include(
      checkConvexSmokeDeploymentTarget({
        deployment: "pathway-dev",
        convexUrl: "not a url",
        allowUrlMismatch: true,
      }),
      "PATHWAY_CYNDRBASE_URL",
    );
  });
});

describe("makeConvexRunSmokeHooks", () => {
  it.effect("seedRegistration runs the backend's `cyndr run smoke:seed`", () =>
    Effect.gen(function* () {
      const { hooks, calls } = yield* makeHooksWith(() => okOutput(SEED_OK_STDOUT));
      yield* hooks.seedRegistration("jkt-1");
      assert.lengthOf(calls, 1);
      const call = calls[0];
      assert.isDefined(call);
      assert.equal(call?.command, "/repo/packages/backend/node_modules/.bin/cyndr");
      assert.deepEqual([...(call?.args ?? [])], ["run", "smoke:seed", SEED_EXPECTED_ARGS]);
      assert.equal(call?.cwd, "/repo/packages/backend");
    }),
  );

  it.effect("pins every subprocess to the configured deployment via CYNDRBASE_DEPLOYMENT", () =>
    Effect.gen(function* () {
      const { hooks, calls } = yield* makeHooksWith(() => okOutput(SEED_OK_STDOUT));
      yield* hooks.seedRegistration("jkt-1");
      const call = calls[0];
      assert.isDefined(call?.env);
      assert.equal(call?.env?.CYNDRBASE_DEPLOYMENT, "pathway-dev");
    }),
  );

  it.effect("refuses to build hooks when the deployment and its URL disagree", () =>
    Effect.gen(function* () {
      const runnerLayer = Layer.succeed(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: () => Effect.die("must not spawn anything on a mismatched target"),
        }),
      );
      const exit = yield* Effect.exit(
        makeConvexRunSmokeHooks({
          ...CONFIG,
          convexUrl: "https://pathway.syd.cyndrbase.cloud",
        }).pipe(Effect.provide(runnerLayer)),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ConvexSyncSmokeHookError);
        assert.include(
          String((error as ConvexSyncSmokeHookError).cause),
          "PATHWAY_CYNDRBASE_SMOKE_ALLOW_URL_MISMATCH=1",
        );
      }
    }),
  );

  it.effect("seedRegistration fails when seed reports a different company id", () =>
    Effect.gen(function* () {
      const { hooks } = yield* makeHooksWith(() => okOutput(SEED_WRONG_COMPANY_STDOUT));
      const exit = yield* Effect.exit(hooks.seedRegistration("jkt-1"));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ConvexSyncSmokeHookError);
        assert.include(String((error as ConvexSyncSmokeHookError).cause), "some-other-company");
      }
    }),
  );

  it.effect("setRegistrationThumbprint requires the registration to exist", () =>
    Effect.gen(function* () {
      // smoke:setThumbprint returns { updated: false } when no registration
      // exists → the hook must fail rather than let a negative case pass vacuously.
      const { hooks, calls } = yield* makeHooksWith(() => okOutput(UPDATED_FALSE_STDOUT));
      const exit = yield* Effect.exit(hooks.setRegistrationThumbprint("jkt-2"));
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(calls[0]?.args[1], "smoke:setThumbprint");
      assert.equal(calls[0]?.args[2], SET_THUMBPRINT_EXPECTED_ARGS);
    }),
  );

  it.effect("revokeRegistration maps { revoked: true } to success", () =>
    Effect.gen(function* () {
      const { hooks, calls } = yield* makeHooksWith(() => okOutput(REVOKED_TRUE_STDOUT));
      yield* hooks.revokeRegistration();
      assert.equal(calls[0]?.args[1], "smoke:revokeRegistration");
      assert.equal(calls[0]?.args[2], ENVIRONMENT_ONLY_EXPECTED_ARGS);
    }),
  );

  it.effect("cleanupRegistration accepts any JSON result, including already-gone counts", () =>
    Effect.gen(function* () {
      const { hooks, calls } = yield* makeHooksWith(() => okOutput(CLEANUP_COUNTS_STDOUT));
      yield* hooks.cleanupRegistration();
      assert.equal(calls[0]?.args[1], "smoke:cleanup");
    }),
  );

  it.effect("a non-zero exit code becomes a hook error carrying stderr", () =>
    Effect.gen(function* () {
      const { hooks } = yield* makeHooksWith(() => ({
        ...okOutput(""),
        code: ChildProcessSpawner.ExitCode(1),
        stderr: "✖ not logged in",
      }));
      const exit = yield* Effect.exit(hooks.cleanupRegistration());
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ConvexSyncSmokeHookError);
        assert.include(String((error as ConvexSyncSmokeHookError).cause), "not logged in");
      }
    }),
  );

  it.effect("non-JSON stdout becomes a hook error", () =>
    Effect.gen(function* () {
      const { hooks } = yield* makeHooksWith(() => okOutput("only logs, no value"));
      const exit = yield* Effect.exit(hooks.revokeRegistration());
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
