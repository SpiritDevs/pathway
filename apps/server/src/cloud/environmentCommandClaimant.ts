// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics unknownInEffectCatch:off
/**
 * Durable target-side execution for Convex environment commands.
 *
 * Convex discovery supervises one claimant for every company that registered this environment.
 * Within each company, `environmentCommands.claim` is both command discovery and lease acquisition:
 * it orders work by creation time and returns an existing live claim unchanged. The same
 * authenticated call refreshes that company's registration at a backend-throttled 30-second
 * cadence. A command is renewed once before any local side effect and then periodically while it
 * runs; losing that fence interrupts local work and suppresses the terminal report.
 *
 * @module cloud/environmentCommandClaimant
 */
import { api } from "@spiritdevs/backend/convexApi";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentCommandArgs,
  ENVIRONMENT_COMMAND_CLAIM_RENEW_INTERVAL_MS,
  ENVIRONMENT_COMMAND_CLAIM_TTL_MS,
  type EnvironmentCommandResult,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
} from "@spiritdevs/contracts";
import type { SyncBootstrapResponse } from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { makeSqliteSyncStore } from "@spiritdevs/client-runtime/sync";
import type { FunctionReturnType } from "convex/server";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { convexErrorCode, type ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import { convexHttpClientLike, type ConvexClientLike } from "./convexSyncTransport.ts";
import {
  awaitCloudSyncLink,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
  discoverCloudSyncCompanyIds,
  makeCloudSyncTokenProvider,
  readCloudSyncLink,
  resolveCloudSyncConfig,
  superviseCloudSyncCompanies,
} from "./syncDaemon.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import { makeSyncSqliteExecutor } from "./syncSqliteExecutor.ts";

export const ENVIRONMENT_COMMAND_CLAIM_LIMIT = 2;
export const DEFAULT_ENVIRONMENT_COMMAND_ACTIVE_POLL_MS = 250;
export const DEFAULT_ENVIRONMENT_COMMAND_IDLE_POLL_MS = 5_000;
export const DEFAULT_ENVIRONMENT_COMMAND_ERROR_POLL_MS = 15_000;
export const DEFAULT_ENVIRONMENT_COMMAND_JITTER_RATIO = 0.2;

type ClaimResponse = FunctionReturnType<typeof api.environmentCommands.claim>;
export type ClaimedEnvironmentCommand = ClaimResponse[number];

export interface EnvironmentCommandBackend {
  readonly claim: (input: {
    readonly companyId: string;
    readonly limit: number;
    readonly claimTtlMs: number;
  }) => Effect.Effect<ClaimResponse, unknown>;
  readonly renewClaim: (input: {
    readonly companyId: string;
    readonly commandId: string;
    readonly claimGeneration: number;
    readonly claimTtlMs: number;
  }) => Effect.Effect<void, unknown>;
  readonly reportStatus: (input: {
    readonly companyId: string;
    readonly commandId: string;
    readonly claimGeneration: number;
    readonly state: "succeeded" | "failed";
    readonly result: EnvironmentCommandResult | null;
    readonly error: string | null;
  }) => Effect.Effect<void, unknown>;
  readonly bootstrap: (input: {
    readonly companyId: string;
    readonly cursor: string | null;
  }) => Effect.Effect<SyncBootstrapResponse, unknown>;
}

export interface EnvironmentCommandExecutor {
  readonly execute: (
    command: ClaimedEnvironmentCommand,
  ) => Effect.Effect<EnvironmentCommandResult, unknown>;
}

export interface EnvironmentCommandTiming {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
  /** A stable injectable unit interval source. */
  readonly random: () => number;
  readonly claimTtlMs: number;
  readonly renewIntervalMs: number;
  readonly activePollMs: number;
  readonly idlePollMs: number;
  readonly errorPollMs: number;
  readonly jitterRatio: number;
}

const defaultTiming: EnvironmentCommandTiming = {
  now: Date.now,
  sleep: (milliseconds) => Effect.sleep(Duration.millis(milliseconds)),
  random: Math.random,
  claimTtlMs: ENVIRONMENT_COMMAND_CLAIM_TTL_MS,
  renewIntervalMs: ENVIRONMENT_COMMAND_CLAIM_RENEW_INTERVAL_MS,
  activePollMs: DEFAULT_ENVIRONMENT_COMMAND_ACTIVE_POLL_MS,
  idlePollMs: DEFAULT_ENVIRONMENT_COMMAND_IDLE_POLL_MS,
  errorPollMs: DEFAULT_ENVIRONMENT_COMMAND_ERROR_POLL_MS,
  jitterRatio: DEFAULT_ENVIRONMENT_COMMAND_JITTER_RATIO,
};

export interface EnvironmentCommandClaimantRuntime {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly backend: EnvironmentCommandBackend;
  readonly executor: EnvironmentCommandExecutor;
  readonly isBootstrapped: Effect.Effect<boolean, unknown>;
  readonly timing?: Partial<EnvironmentCommandTiming>;
}

export type EnvironmentCommandClaimCycle = "unready" | "idle" | "claimed" | "transport-error";

class EnvironmentCommandFenceLostError extends Error {
  readonly _tag = "EnvironmentCommandFenceLostError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureSummary(cause: Cause.Cause<unknown>): string {
  return Cause.pretty(cause).slice(0, 2_000);
}

function activeRun(projection: OrchestrationV2ThreadProjection): OrchestrationV2Run | undefined {
  return projection.runs.findLast(
    (run) =>
      run.status === "preparing" ||
      run.status === "queued" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );
}

function statusResult(
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
): EnvironmentCommandResult {
  const run = projection.runs.at(-1);
  const sessionStatus = (() => {
    switch (run?.status) {
      case undefined:
        return "idle" as const;
      case "preparing":
      case "queued":
      case "starting":
        return "starting" as const;
      case "running":
        return "running" as const;
      case "waiting":
        return "ready" as const;
      case "interrupted":
        return "interrupted" as const;
      case "failed":
        return "error" as const;
      case "completed":
      case "cancelled":
      case "rolled_back":
        return "stopped" as const;
    }
  })();
  return { kind: "statusQuery", threadId, sessionStatus, activeTurnId: null };
}

export interface LocalEnvironmentCommandServices {
  readonly launch: ThreadLaunch.ThreadLaunchService["Service"]["launch"];
  readonly dispatch: ThreadManagement.ThreadManagementService["Service"]["dispatch"];
  readonly getThreadProjection: ThreadManagement.ThreadManagementService["Service"]["getThreadProjection"];
  readonly resolveStartTarget: (
    command: ClaimedEnvironmentCommand,
    requestedModel: ModelSelection | null,
  ) => Effect.Effect<
    { readonly projectId: ProjectId; readonly modelSelection: ModelSelection },
    unknown
  >;
}

/** Executes the same target-local orchestration commands used by direct remote dispatch. */
export function makeLocalEnvironmentCommandExecutor(
  services: LocalEnvironmentCommandServices,
): EnvironmentCommandExecutor {
  const decodeArgs = Schema.decodeUnknownEffect(EnvironmentCommandArgs);
  return {
    execute: (command) =>
      Effect.gen(function* () {
        const args = yield* decodeArgs(command.args);
        if (args.kind !== command.kind) {
          return yield* Effect.fail("The command kind does not match its arguments.");
        }
        const commandId = CommandId.make(command.id);
        switch (args.kind) {
          case "startThread": {
            const target = yield* services.resolveStartTarget(command, args.modelSelection);
            // This is the crash-recovery identity: ThreadLaunchService persists its receipt under
            // the EnvironmentCommandId unchanged. A restarted claimant may receive a new claim
            // generation, but replaying this command id returns the same thread without launching
            // a second one.
            const launched = yield* services.launch({
              commandId,
              projectId: target.projectId,
              title: "New delegated task",
              generateTitle: true,
              modelSelection: target.modelSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              workspaceStrategy: { type: "root" },
              initialMessage: { text: args.prompt, attachments: [] },
              createdBy: "agent",
              creationSource: "mcp",
            });
            return { kind: "startThread", threadId: launched.threadId };
          }
          case "sendMessage": {
            const threadId = ThreadId.make(args.threadId);
            const before = yield* services.getThreadProjection(threadId);
            yield* services.dispatch({
              type: "message.dispatch",
              commandId,
              threadId,
              messageId: MessageId.make(`${command.id}:message`),
              text: args.message,
              attachments: [],
              dispatchMode:
                activeRun(before) === undefined
                  ? { type: "start_immediately" }
                  : { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "mcp",
            });
            return { kind: "sendMessage", threadId, turnId: null };
          }
          case "interrupt": {
            const threadId = ThreadId.make(args.threadId);
            const projection = yield* services.getThreadProjection(threadId);
            const run = activeRun(projection);
            if (run !== undefined) {
              yield* services.dispatch({
                type: "run.interrupt",
                commandId,
                threadId,
                runId: run.id,
              });
            }
            return { kind: "interrupt", threadId };
          }
          case "statusQuery": {
            const threadId = ThreadId.make(args.threadId);
            return statusResult(threadId, yield* services.getThreadProjection(threadId));
          }
        }
      }),
  };
}

function isEnvironmentCommandFenceLost(error: unknown): error is EnvironmentCommandFenceLostError {
  return error instanceof EnvironmentCommandFenceLostError;
}

/** Runs one claimed command under its generation fence. */
export const executeClaimedEnvironmentCommand = Effect.fn(
  "cloud.environment_command_claimant.execute_claimed",
)(function* (runtime: EnvironmentCommandClaimantRuntime, command: ClaimedEnvironmentCommand) {
  const timing = { ...defaultTiming, ...runtime.timing };
  if (
    command.state !== "claimed" ||
    command.claimedByEnvironmentId !== runtime.environmentId ||
    command.expiresAt <= timing.now()
  ) {
    return "abandoned" as const;
  }

  const renew = runtime.backend.renewClaim({
    companyId: runtime.companyId,
    commandId: command.id,
    claimGeneration: command.claimGeneration,
    claimTtlMs: timing.claimTtlMs,
  });
  const preflight = yield* Effect.exit(renew);
  if (Exit.isFailure(preflight)) {
    yield* Effect.logDebug("Environment command claim was lost before execution", {
      commandId: command.id,
      claimGeneration: command.claimGeneration,
      cause: preflight.cause,
    });
    return "abandoned" as const;
  }

  const execution = yield* Effect.scoped(
    Effect.gen(function* () {
      const fenceLost = yield* Deferred.make<unknown>();
      const renewLoop = timing.sleep(timing.renewIntervalMs).pipe(
        Effect.andThen(Effect.exit(renew)),
        Effect.flatMap((renewal) =>
          Exit.isSuccess(renewal)
            ? Effect.void
            : Deferred.succeed(fenceLost, renewal.cause).pipe(Effect.asVoid),
        ),
        Effect.forever,
      );
      yield* renewLoop.pipe(Effect.forkScoped);
      const lost = Deferred.await(fenceLost).pipe(
        Effect.flatMap((cause) =>
          Effect.fail(
            new EnvironmentCommandFenceLostError(
              `Claim ${command.claimGeneration} for ${command.id} was lost: ${Cause.pretty(cause as Cause.Cause<unknown>)}`,
            ),
          ),
        ),
      );
      return yield* Effect.exit(Effect.raceFirst(runtime.executor.execute(command), lost));
    }),
  );

  if (Exit.isFailure(execution)) {
    const failure = Cause.squash(execution.cause);
    if (isEnvironmentCommandFenceLost(failure)) {
      yield* Effect.logDebug("Environment command execution abandoned after losing its fence", {
        commandId: command.id,
        claimGeneration: command.claimGeneration,
      });
      return "abandoned" as const;
    }
    const error = failureSummary(execution.cause);
    yield* runtime.backend
      .reportStatus({
        companyId: runtime.companyId,
        commandId: command.id,
        claimGeneration: command.claimGeneration,
        state: "failed",
        result: null,
        error,
      })
      .pipe(
        Effect.catch((reportError) =>
          Effect.logDebug("Environment command failure could not be reported", {
            commandId: command.id,
            claimGeneration: command.claimGeneration,
            code: convexErrorCode(reportError),
            error: errorText(reportError),
          }),
        ),
      );
    return "failed" as const;
  }

  const report = yield* Effect.exit(
    runtime.backend.reportStatus({
      companyId: runtime.companyId,
      commandId: command.id,
      claimGeneration: command.claimGeneration,
      state: "succeeded",
      result: execution.value,
      error: null,
    }),
  );
  if (Exit.isFailure(report)) {
    yield* Effect.logDebug("Environment command success could not be reported", {
      commandId: command.id,
      claimGeneration: command.claimGeneration,
      cause: report.cause,
    });
    return "abandoned" as const;
  }
  return "succeeded" as const;
});

/** One bounded discovery/claim/execution turn; exported so tests do not need a polling fiber. */
export const runEnvironmentCommandClaimCycle = Effect.fn(
  "cloud.environment_command_claimant.cycle",
)(function* (runtime: EnvironmentCommandClaimantRuntime) {
  const timing = { ...defaultTiming, ...runtime.timing };
  const ready = yield* runtime.isBootstrapped.pipe(Effect.orElseSucceed(() => false));
  if (!ready) return "unready" satisfies EnvironmentCommandClaimCycle;

  const claimed = yield* Effect.exit(
    runtime.backend.claim({
      companyId: runtime.companyId,
      limit: ENVIRONMENT_COMMAND_CLAIM_LIMIT,
      claimTtlMs: timing.claimTtlMs,
    }),
  );
  if (Exit.isFailure(claimed)) {
    yield* Effect.logDebug("Environment command claim poll failed", { cause: claimed.cause });
    return "transport-error" satisfies EnvironmentCommandClaimCycle;
  }

  const executable = claimed.value
    .filter(
      (command) =>
        command.state === "claimed" &&
        command.claimedByEnvironmentId === runtime.environmentId &&
        command.expiresAt > timing.now(),
    )
    // `createdAt` is the backend's issuance timestamp and the ordering key used by `claim`.
    .toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  if (executable.length === 0) return "idle" satisfies EnvironmentCommandClaimCycle;

  yield* Effect.forEach(
    executable,
    (command) => executeClaimedEnvironmentCommand(runtime, command),
    {
      concurrency: ENVIRONMENT_COMMAND_CLAIM_LIMIT,
      discard: true,
    },
  );
  return "claimed" satisfies EnvironmentCommandClaimCycle;
});

function jittered(milliseconds: number, timing: EnvironmentCommandTiming): number {
  const centered = Math.min(1, Math.max(0, timing.random())) * 2 - 1;
  return Math.max(1, Math.round(milliseconds * (1 + centered * timing.jitterRatio)));
}

export const runEnvironmentCommandClaimant = Effect.fn("cloud.environment_command_claimant.run")(
  function* (runtime: EnvironmentCommandClaimantRuntime) {
    const timing = { ...defaultTiming, ...runtime.timing };
    return yield* Effect.gen(function* () {
      const outcome = yield* runEnvironmentCommandClaimCycle(runtime);
      const base =
        outcome === "claimed"
          ? timing.activePollMs
          : outcome === "transport-error"
            ? timing.errorPollMs
            : timing.idlePollMs;
      yield* timing.sleep(jittered(base, timing));
    }).pipe(Effect.forever);
  },
);

function isAuthorizationFailure(error: unknown): boolean {
  const code = convexErrorCode(error);
  return (
    code === "not-authenticated" ||
    code === "environment-not-registered" ||
    code === "environment-key-mismatch" ||
    errorText(error).includes("401") ||
    errorText(error).includes("403")
  );
}

export const makeEnvironmentCommandBackend = Effect.fn(
  "cloud.environment_command_claimant.backend",
)(function* (input: {
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  readonly client?: ConvexClientLike;
}) {
  const client = input.client ?? convexHttpClientLike(input.convexUrl);
  const lock = yield* Semaphore.make(1);
  const issue = <A>(token: string, call: (convex: ConvexClientLike) => Promise<A>) =>
    lock.withPermits(1)(
      Effect.sync(() => client.setAuth(token)).pipe(
        Effect.andThen(Effect.tryPromise({ try: () => call(client), catch: (error) => error })),
      ),
    );
  const authorized = <A>(
    call: (convex: ConvexClientLike) => Promise<A>,
  ): Effect.Effect<A, unknown> =>
    input.tokens.token.pipe(
      Effect.flatMap((token) =>
        issue(token, call).pipe(
          Effect.catchIf(isAuthorizationFailure, () =>
            input.tokens.invalidate(token).pipe(
              Effect.andThen(input.tokens.token),
              Effect.flatMap((fresh) => issue(fresh, call)),
            ),
          ),
        ),
      ),
    );

  return {
    claim: (args) => authorized((convex) => convex.mutation(api.environmentCommands.claim, args)),
    renewClaim: (args) =>
      authorized((convex) => convex.mutation(api.environmentCommands.renewClaim, args)),
    reportStatus: (args) =>
      authorized((convex) => convex.mutation(api.environmentCommands.reportStatus, args)),
    bootstrap: (args) =>
      authorized((convex) => convex.query(api.sync.bootstrap, args)).pipe(
        Effect.map((response) => response as unknown as SyncBootstrapResponse),
      ),
  } satisfies EnvironmentCommandBackend;
});

interface EnvironmentBindingPayload {
  readonly id: string;
  readonly cloudProjectId: string;
  readonly environmentId: string;
  readonly localProjectId: string;
  readonly status: string;
}

function decodeBinding(payload: unknown): EnvironmentBindingPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;
  return typeof row["id"] === "string" &&
    typeof row["cloudProjectId"] === "string" &&
    typeof row["environmentId"] === "string" &&
    typeof row["localProjectId"] === "string" &&
    typeof row["status"] === "string"
    ? {
        id: row["id"],
        cloudProjectId: row["cloudProjectId"],
        environmentId: row["environmentId"],
        localProjectId: row["localProjectId"],
        status: row["status"],
      }
    : null;
}

const readEnvironmentBindings = Effect.fn("cloud.environment_command_claimant.read_bindings")(
  function* (backend: EnvironmentCommandBackend, companyId: CompanyId) {
    const bindings: EnvironmentBindingPayload[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    while (true) {
      const page: SyncBootstrapResponse = yield* backend.bootstrap({ companyId, cursor });
      for (const entity of page.entities) {
        if (entity.entityKind !== "environmentBinding" || entity.changeKind !== "upsert") continue;
        const binding = decodeBinding(entity.payload);
        if (binding !== null) bindings.push(binding);
      }
      if (page.isDone || page.cursor === null) return bindings;
      if (cursors.has(page.cursor))
        return yield* Effect.fail("Convex repeated a bootstrap cursor.");
      cursors.add(page.cursor);
      cursor = page.cursor;
    }
  },
);

function makeLiveExecutor(input: {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly backend: EnvironmentCommandBackend;
  readonly launcher: ThreadLaunch.ThreadLaunchService["Service"];
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly projects: ProjectService.ProjectService["Service"];
  readonly settings: ServerSettings.ServerSettingsService["Service"];
}): EnvironmentCommandExecutor {
  return makeLocalEnvironmentCommandExecutor({
    launch: input.launcher.launch,
    dispatch: input.threads.dispatch,
    getThreadProjection: input.threads.getThreadProjection,
    resolveStartTarget: (command, requestedModel) =>
      Effect.gen(function* () {
        if (command.cloudProjectId === null) {
          return yield* Effect.fail("A start-thread command needs a cloud project binding.");
        }
        const bindings = (yield* readEnvironmentBindings(input.backend, input.companyId)).filter(
          (binding) =>
            binding.environmentId === input.environmentId &&
            binding.cloudProjectId === command.cloudProjectId &&
            binding.status === "active" &&
            (command.bindingId === null || command.bindingId === binding.id),
        );
        if (bindings.length !== 1) {
          return yield* Effect.fail(
            bindings.length === 0
              ? "No active local binding exists for the command's cloud project."
              : "Several active local bindings match the command's cloud project.",
          );
        }
        const projectId = ProjectId.make(bindings[0]!.localProjectId);
        const project = yield* input.projects.getById(projectId);
        if (Option.isNone(project)) {
          return yield* Effect.fail("The command's environment binding names a missing project.");
        }
        const serverSettings = yield* input.settings.getSettings;
        return {
          projectId,
          modelSelection:
            requestedModel ??
            project.value.defaultModelSelection ??
            serverSettings.textGenerationModelSelection,
        };
      }),
  });
}

export interface EnvironmentCommandClaimantOptions {
  /** Tests are dark by default; pass true only in an explicit claimant test. */
  readonly enabled?: boolean;
  readonly timing?: Partial<EnvironmentCommandTiming>;
  readonly backend?: EnvironmentCommandBackend;
  readonly executor?: EnvironmentCommandExecutor;
  readonly isBootstrapped?: Effect.Effect<boolean, unknown>;
}

/** The shared cloud-sync configuration/link gate, kept separate for a hermetic fail-closed test. */
export const resolveEnvironmentCommandClaimantActivation: Effect.Effect<
  { readonly convexUrl: string } | null,
  never
> = Effect.gen(function* () {
  const config = yield* resolveCloudSyncConfig;
  if (config._tag !== "Configured") {
    yield* Effect.logDebug("Environment command claimant not started", { reason: config.reason });
    return null;
  }
  return config.settings;
});

export const startEnvironmentCommandClaimant = Effect.fn(
  "cloud.environment_command_claimant.start",
)(function* (options: EnvironmentCommandClaimantOptions = {}) {
  const vitest = yield* Config.string("VITEST").pipe(Config.withDefault(""));
  if (options.enabled === false || (vitest.length > 0 && options.enabled !== true)) {
    yield* Effect.logDebug("Environment command claimant not started in tests");
    return null;
  }
  const activation = yield* resolveEnvironmentCommandClaimantActivation;
  if (activation === null) return null;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;

  yield* Effect.logInfo("Environment command claimant supervisor started", {
    environmentId,
    concurrency: ENVIRONMENT_COMMAND_CLAIM_LIMIT,
  });
  return yield* forkParkedFiber(
    Effect.gen(function* () {
      const link = yield* awaitCloudSyncLink({
        secrets,
        interval: DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
        attempts: DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
      });
      if (link === null) return;
      const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets).pipe(
        Effect.orDie,
      );
      const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys });
      const backend =
        options.backend ??
        (yield* makeEnvironmentCommandBackend({ convexUrl: activation.convexUrl, tokens }));
      const store = yield* makeSqliteSyncStore(yield* makeSyncSqliteExecutor);
      const runCompany = (companyId: CompanyId) => {
        const isBootstrapped =
          options.isBootstrapped ??
          Effect.all([store.service.read(companyId), readCloudSyncLink(secrets)]).pipe(
            Effect.map(
              ([state, currentLink]) =>
                state.checkpoint?.bootstrapped === true && currentLink !== null,
            ),
          );
        const executor =
          options.executor ??
          makeLiveExecutor({
            companyId,
            environmentId,
            backend,
            launcher,
            threads,
            projects,
            settings,
          });
        const runtime = {
          companyId,
          environmentId,
          backend,
          executor,
          isBootstrapped,
          ...(options.timing === undefined ? {} : { timing: options.timing }),
        } satisfies EnvironmentCommandClaimantRuntime;
        return runEnvironmentCommandClaimant(runtime);
      };

      yield* superviseCloudSyncCompanies({
        discover: () =>
          discoverCloudSyncCompanyIds({
            convexUrl: activation.convexUrl,
            tokens,
          }),
        runCompany,
        workerLabel: "environment-command-claimant",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logWarning("Environment command claimant supervisor stopped", { cause }),
      ),
    ),
  );
});

export type EnvironmentCommandClaimantFiber = Fiber.Fiber<void>;

export const environmentCommandClaimantLayer = (
  options: EnvironmentCommandClaimantOptions = {},
): Layer.Layer<
  never,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | SqlClient.SqlClient
  | HttpClient.HttpClient
  | ThreadLaunch.ThreadLaunchService
  | ThreadManagement.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
> =>
  Layer.effectDiscard(
    startEnvironmentCommandClaimant(options).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Environment command claimant failed to start; continuing without remote command execution",
          { cause },
        ),
      ),
    ),
  );
