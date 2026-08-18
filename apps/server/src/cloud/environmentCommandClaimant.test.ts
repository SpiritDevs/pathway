// @effect-diagnostics anyUnknownInErrorContext:off
import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type EnvironmentCommandKind,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexError } from "convex/values";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  executeClaimedEnvironmentCommand,
  makeLocalEnvironmentCommandExecutor,
  resolveEnvironmentCommandClaimantActivation,
  runEnvironmentCommandClaimCycle,
  type ClaimedEnvironmentCommand,
  type EnvironmentCommandBackend,
  type EnvironmentCommandClaimantRuntime,
  type EnvironmentCommandExecutor,
  type LocalEnvironmentCommandServices,
} from "./environmentCommandClaimant.ts";

const COMPANY_ID = CompanyId.make("company-command-claimant");
const ENVIRONMENT_ID = EnvironmentId.make("environment-command-target");
const PROJECT_ID = ProjectId.make("project-command-target");
const THREAD_ID = ThreadId.make("thread-command-target");
const MODEL = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
} as const;
const NOW = 10_000;

class TestLocalExecutionError extends Schema.TaggedErrorClass<TestLocalExecutionError>()(
  "TestLocalExecutionError",
  { message: Schema.String },
) {}

function command(
  kind: EnvironmentCommandKind,
  args: unknown,
  overrides: Partial<ClaimedEnvironmentCommand> = {},
): ClaimedEnvironmentCommand {
  return {
    id: `environment-command-${kind}`,
    kind,
    state: "claimed",
    targetEnvironmentId: ENVIRONMENT_ID,
    cloudProjectId: kind === "startThread" ? "cloud-project-command-target" : null,
    bindingId: null,
    args,
    issuedByMembershipId: "membership-command-issuer",
    onBehalfOfActor: { kind: "member", membershipId: "membership-command-issuer" },
    claimedByEnvironmentId: ENVIRONMENT_ID,
    claimGeneration: 1,
    claimExpiresAt: NOW + 90_000,
    expiresAt: NOW + 600_000,
    result: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ClaimedEnvironmentCommand;
}

function projection(running = false): OrchestrationV2ThreadProjection {
  return {
    thread: { id: THREAD_ID, projectId: PROJECT_ID },
    runs: running
      ? [
          {
            id: RunId.make("run-command-target"),
            status: "running",
            ordinal: 1,
          },
        ]
      : [],
  } as unknown as OrchestrationV2ThreadProjection;
}

interface ReportCall {
  readonly companyId: string;
  readonly commandId: string;
  readonly claimGeneration: number;
  readonly state: "succeeded" | "failed";
  readonly result: unknown;
  readonly error: string | null;
}

function backendHarness(input: {
  readonly claim: EnvironmentCommandBackend["claim"];
  readonly renewClaim?: EnvironmentCommandBackend["renewClaim"];
}) {
  const reports: ReportCall[] = [];
  const claimCalls: Array<{
    readonly companyId: string;
    readonly limit: number;
    readonly claimTtlMs: number;
  }> = [];
  const renewCalls: Array<{
    readonly companyId: string;
    readonly commandId: string;
    readonly claimGeneration: number;
    readonly claimTtlMs: number;
  }> = [];
  let renewals = 0;
  const backend: EnvironmentCommandBackend = {
    claim: (args) => {
      claimCalls.push(args);
      return input.claim(args);
    },
    renewClaim: (args) => {
      renewals += 1;
      renewCalls.push(args);
      return input.renewClaim?.(args) ?? Effect.void;
    },
    reportStatus: (args) =>
      Effect.sync(() => {
        reports.push(args);
      }),
    bootstrap: () => Effect.die("bootstrap is not used by this fake"),
  };
  return { backend, reports, claimCalls, renewCalls, renewals: () => renewals };
}

function runtime(input: {
  readonly backend: EnvironmentCommandBackend;
  readonly executor: EnvironmentCommandExecutor;
  readonly bootstrapped?: boolean;
  readonly companyId?: CompanyId;
}): EnvironmentCommandClaimantRuntime {
  return {
    companyId: input.companyId ?? COMPANY_ID,
    environmentId: ENVIRONMENT_ID,
    backend: input.backend,
    executor: input.executor,
    isBootstrapped: Effect.succeed(input.bootstrapped ?? true),
    timing: {
      now: () => NOW,
      random: () => 0.5,
      // Immediate commands complete before the periodic renewal fiber reaches this sleep.
      sleep: () => Effect.never,
    },
  };
}

function localExecutorHarness(projectionValue = projection()) {
  const launches = new Map<string, ThreadId>();
  const launchAttempts: string[] = [];
  const launchSideEffects: string[] = [];
  const dispatches: OrchestrationV2Command[] = [];
  const services: LocalEnvironmentCommandServices = {
    launch: (input) =>
      Effect.sync(() => {
        launchAttempts.push(input.commandId);
        let threadId = launches.get(input.commandId);
        if (threadId === undefined) {
          threadId = THREAD_ID;
          launches.set(input.commandId, threadId);
          launchSideEffects.push(input.commandId);
        }
        return {
          threadId,
          projection: projectionValue,
          resumed: launchSideEffects.length < launchAttempts.length,
        };
      }),
    dispatch: (dispatched) =>
      Effect.sync(() => {
        dispatches.push(dispatched);
        return { storedEvents: [] } as never;
      }),
    getThreadProjection: () => Effect.succeed(projectionValue),
    resolveStartTarget: () => Effect.succeed({ projectId: PROJECT_ID, modelSelection: MODEL }),
  };
  return {
    executor: makeLocalEnvironmentCommandExecutor(services),
    launchAttempts,
    launchSideEffects,
    dispatches,
  };
}

const runHappy = (claimed: ClaimedEnvironmentCommand, projectionValue = projection()) =>
  Effect.gen(function* () {
    const local = localExecutorHarness(projectionValue);
    const convex = backendHarness({ claim: () => Effect.succeed([claimed]) });
    const outcome = yield* runEnvironmentCommandClaimCycle(
      runtime({ backend: convex.backend, executor: local.executor }),
    );
    return { outcome, local, convex };
  });

describe("environment command claimant", () => {
  it.effect("keeps claim routing separate for every registered company", () =>
    Effect.gen(function* () {
      const convex = backendHarness({ claim: () => Effect.succeed([]) });
      const executor = { execute: () => Effect.die("must not execute") };
      const companyA = CompanyId.make("company-a");
      const companyB = CompanyId.make("company-b");

      yield* Effect.all(
        [
          runEnvironmentCommandClaimCycle(
            runtime({ backend: convex.backend, executor, companyId: companyA }),
          ),
          runEnvironmentCommandClaimCycle(
            runtime({ backend: convex.backend, executor, companyId: companyB }),
          ),
        ],
        { concurrency: "unbounded" },
      );

      expect(convex.claimCalls.map(({ companyId }) => companyId).toSorted()).toEqual([
        companyA,
        companyB,
      ]);
    }),
  );

  it.effect("claims, starts a thread, and reports its pointer under the same command id", () =>
    Effect.gen(function* () {
      const claimed = command("startThread", {
        kind: "startThread",
        prompt: "Implement the remote task.",
        modelSelection: MODEL,
      });
      const { outcome, local, convex } = yield* runHappy(claimed);

      assert.equal(outcome, "claimed");
      assert.deepEqual(local.launchAttempts, [claimed.id]);
      assert.deepEqual(convex.claimCalls, [
        { companyId: COMPANY_ID, limit: 2, claimTtlMs: 90_000 },
      ]);
      assert.deepEqual(convex.renewCalls, [
        {
          companyId: COMPANY_ID,
          commandId: claimed.id,
          claimGeneration: 1,
          claimTtlMs: 90_000,
        },
      ]);
      assert.deepEqual(convex.reports, [
        {
          companyId: COMPANY_ID,
          commandId: claimed.id,
          claimGeneration: 1,
          state: "succeeded",
          result: { kind: "startThread", threadId: THREAD_ID },
          error: null,
        },
      ]);
    }),
  );

  it.effect("claims, sends a message with the command-derived message receipt, and reports", () =>
    Effect.gen(function* () {
      const claimed = command("sendMessage", {
        kind: "sendMessage",
        threadId: THREAD_ID,
        message: "Continue with the tests.",
      });
      const { local, convex } = yield* runHappy(claimed, projection(true));

      assert.equal(local.dispatches[0]?.type, "message.dispatch");
      assert.equal(local.dispatches[0]?.commandId, claimed.id);
      assert.equal(
        local.dispatches[0]?.type === "message.dispatch" ? local.dispatches[0].messageId : null,
        `${claimed.id}:message`,
      );
      assert.deepEqual(convex.reports[0]?.result, {
        kind: "sendMessage",
        threadId: THREAD_ID,
        turnId: null,
      });
    }),
  );

  it.effect("claims, interrupts the active run, and reports", () =>
    Effect.gen(function* () {
      const claimed = command("interrupt", { kind: "interrupt", threadId: THREAD_ID });
      const { local, convex } = yield* runHappy(claimed, projection(true));

      assert.equal(local.dispatches[0]?.type, "run.interrupt");
      assert.equal(local.dispatches[0]?.commandId, claimed.id);
      assert.deepEqual(convex.reports[0]?.result, { kind: "interrupt", threadId: THREAD_ID });
    }),
  );

  it.effect("claims, queries local status without a side effect, and reports", () =>
    Effect.gen(function* () {
      const claimed = command("statusQuery", { kind: "statusQuery", threadId: THREAD_ID });
      const { local, convex } = yield* runHappy(claimed, projection(true));

      assert.isEmpty(local.dispatches);
      assert.deepEqual(convex.reports[0]?.result, {
        kind: "statusQuery",
        threadId: THREAD_ID,
        sessionStatus: "running",
        activeTurnId: null,
      });
    }),
  );

  it.effect("abandons a claim whose generation fence was stolen before execution", () =>
    Effect.gen(function* () {
      const claimed = command("startThread", {
        kind: "startThread",
        prompt: "Must not launch.",
        modelSelection: MODEL,
      });
      let executions = 0;
      const convex = backendHarness({
        claim: () => Effect.succeed([claimed]),
        renewClaim: () =>
          Effect.fail(
            new ConvexError({ code: "stale-command-claim", message: "new generation owns it" }),
          ),
      });
      yield* runEnvironmentCommandClaimCycle(
        runtime({
          backend: convex.backend,
          executor: {
            execute: () => Effect.sync(() => void (executions += 1)) as never,
          },
        }),
      );

      assert.equal(executions, 0);
      assert.isEmpty(convex.reports);
    }),
  );

  it.effect("never executes a command canceled before claim", () =>
    Effect.gen(function* () {
      let executions = 0;
      const convex = backendHarness({ claim: () => Effect.succeed([]) });
      const outcome = yield* runEnvironmentCommandClaimCycle(
        runtime({
          backend: convex.backend,
          executor: {
            execute: () => Effect.sync(() => void (executions += 1)) as never,
          },
        }),
      );

      assert.equal(outcome, "idle");
      assert.equal(executions, 0);
      assert.isEmpty(convex.reports);
    }),
  );

  it.effect("stops cloud calls after unlink and resumes the same claimant after relink", () =>
    Effect.gen(function* () {
      let linked = true;
      const convex = backendHarness({ claim: () => Effect.succeed([]) });
      const claimant: EnvironmentCommandClaimantRuntime = {
        ...runtime({
          backend: convex.backend,
          executor: { execute: () => Effect.die("no command should execute") },
        }),
        isBootstrapped: Effect.sync(() => linked),
      };

      assert.equal(yield* runEnvironmentCommandClaimCycle(claimant), "idle");
      linked = false;
      assert.equal(yield* runEnvironmentCommandClaimCycle(claimant), "unready");
      linked = true;
      assert.equal(yield* runEnvironmentCommandClaimCycle(claimant), "idle");

      assert.lengthOf(convex.claimCalls, 2);
    }),
  );

  it.effect("skips a command whose command-level TTL elapsed", () =>
    Effect.gen(function* () {
      const expired = command(
        "statusQuery",
        { kind: "statusQuery", threadId: THREAD_ID },
        { expiresAt: NOW },
      );
      let executions = 0;
      const convex = backendHarness({ claim: () => Effect.succeed([expired]) });
      const outcome = yield* runEnvironmentCommandClaimCycle(
        runtime({
          backend: convex.backend,
          executor: {
            execute: () => Effect.sync(() => void (executions += 1)) as never,
          },
        }),
      );

      assert.equal(outcome, "idle");
      assert.equal(executions, 0);
      assert.isEmpty(convex.reports);
    }),
  );

  it.effect("redelivery converges on the durable launch receipt instead of launching twice", () =>
    Effect.gen(function* () {
      const first = command("startThread", {
        kind: "startThread",
        prompt: "Recover after restart.",
        modelSelection: MODEL,
      });
      const redelivery = command("startThread", first.args, { claimGeneration: 2 });
      const local = localExecutorHarness();
      let claims = 0;
      const convex = backendHarness({
        claim: () => Effect.sync(() => [claims++ === 0 ? first : redelivery]),
      });
      const claimant = runtime({ backend: convex.backend, executor: local.executor });

      yield* runEnvironmentCommandClaimCycle(claimant);
      yield* runEnvironmentCommandClaimCycle(claimant);

      assert.deepEqual(local.launchAttempts, [first.id, first.id]);
      assert.deepEqual(local.launchSideEffects, [first.id]);
      assert.deepEqual(
        convex.reports.map((report) => report.result),
        [
          { kind: "startThread", threadId: THREAD_ID },
          { kind: "startThread", threadId: THREAD_ID },
        ],
      );
    }),
  );

  it.effect("reports a bounded failure summary when local execution fails", () =>
    Effect.gen(function* () {
      const claimed = command("sendMessage", {
        kind: "sendMessage",
        threadId: THREAD_ID,
        message: "This dispatch fails.",
      });
      const convex = backendHarness({ claim: () => Effect.succeed([claimed]) });
      yield* runEnvironmentCommandClaimCycle(
        runtime({
          backend: convex.backend,
          executor: {
            execute: () =>
              Effect.fail(new TestLocalExecutionError({ message: "local dispatch failed" })),
          },
        }),
      );

      assert.equal(convex.reports[0]?.state, "failed");
      assert.isNull(convex.reports[0]?.result);
      assert.include(convex.reports[0]?.error ?? "", "local dispatch failed");
      assert.isAtMost(convex.reports[0]?.error?.length ?? 0, 2_000);
    }),
  );

  it.effect("renews the claim on cadence while slow local execution is running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const claimed = command("statusQuery", { kind: "statusQuery", threadId: THREAD_ID });
        const executionStarted = yield* Deferred.make<void>();
        const releaseExecution = yield* Deferred.make<void>();
        const sleepStarted = yield* Deferred.make<void>();
        const allowRenewal = yield* Deferred.make<void>();
        const renewed = yield* Deferred.make<void>();
        let sleeps = 0;
        let renewals = 0;
        const convex = backendHarness({
          claim: () => Effect.succeed([claimed]),
          renewClaim: () =>
            Effect.sync(() => {
              renewals += 1;
            }).pipe(
              Effect.tap(() =>
                renewals >= 2 ? Deferred.succeed(renewed, undefined) : Effect.void,
              ),
            ),
        });
        const claimant: EnvironmentCommandClaimantRuntime = {
          ...runtime({
            backend: convex.backend,
            executor: {
              execute: () =>
                Deferred.succeed(executionStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseExecution)),
                  Effect.as({
                    kind: "statusQuery",
                    threadId: THREAD_ID,
                    sessionStatus: "idle",
                    activeTurnId: null,
                  }),
                ),
            },
          }),
          timing: {
            now: () => NOW,
            renewIntervalMs: 30_000,
            sleep: () => {
              sleeps += 1;
              return sleeps === 1
                ? Deferred.succeed(sleepStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(allowRenewal)),
                  )
                : Effect.never;
            },
          },
        };

        const fiber = yield* executeClaimedEnvironmentCommand(claimant, claimed).pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(executionStarted);
        yield* Deferred.await(sleepStarted);
        assert.equal(renewals, 1, "the first renewal is the pre-execution fence check");
        yield* Deferred.succeed(allowRenewal, undefined);
        yield* Deferred.await(renewed);
        assert.equal(renewals, 2);
        yield* Deferred.succeed(releaseExecution, undefined);
        assert.equal(yield* Fiber.join(fiber), "succeeded");
      }),
    ),
  );

  it.effect("activates from the Convex URL without a legacy company setting", () =>
    resolveEnvironmentCommandClaimantActivation.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATHWAY_CONVEX_URL: "https://claimant.convex.cloud" },
          }),
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual({ convexUrl: "https://claimant.convex.cloud" });
        }),
      ),
    ),
  );

  it.effect("does not claim before the local cloud replica has bootstrapped", () =>
    Effect.gen(function* () {
      let claimCalls = 0;
      const convex = backendHarness({
        claim: () =>
          Effect.sync(() => {
            claimCalls += 1;
            return [];
          }),
      });
      const outcome = yield* runEnvironmentCommandClaimCycle(
        runtime({
          backend: convex.backend,
          executor: { execute: () => Effect.die("must not execute") },
          bootstrapped: false,
        }),
      );

      assert.equal(outcome, "unready");
      assert.equal(claimCalls, 0);
    }),
  );
});
