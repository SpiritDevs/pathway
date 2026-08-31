import { resolveSpawnCommand } from "@spiritdevs/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import type { CodexSettings } from "@spiritdevs/contracts";
import { expandHomePath } from "../pathExpansion.ts";
import { buildCodexInitializeParams } from "./Layers/CodexProvider.ts";
import { codexAppServerArgs } from "./Layers/codexLaunchArgs.ts";
import {
  ProviderAuthenticationError,
  type ProviderAuthenticationQuery,
} from "./ProviderAuthentication.ts";

const CODEX_AUTH_FORCE_KILL_AFTER = "2 seconds" as const;
const CODEX_DEVICE_LOGIN_START_ERROR =
  "Codex sign-in could not be started. Make sure device-code authentication is enabled for your OpenAI account or workspace.";

type CodexDeviceLoginResult = Extract<
  CodexSchema.V2LoginAccountResponse,
  { readonly type: "chatgptDeviceCode" }
>;

export interface CodexAuthenticationClient {
  readonly startDeviceLogin: Effect.Effect<
    CodexSchema.V2LoginAccountResponse,
    CodexErrors.CodexAppServerError
  >;
  readonly onLoginCompleted: (
    handler: (notification: CodexSchema.V2AccountLoginCompletedNotification) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly close: (loginId: string | null) => void;
}

function codexAuthenticationError(reason: string, cause?: unknown) {
  return new ProviderAuthenticationError({ reason, ...(cause === undefined ? {} : { cause }) });
}

export const makeCodexAuthenticationQuery = Effect.fn("makeCodexAuthenticationQuery")(function* (
  client: CodexAuthenticationClient,
) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const completion = yield* Deferred.make<void, ProviderAuthenticationError>();
  let loginId: string | null = null;

  yield* client.onLoginCompleted((notification) => {
    if (loginId === null || (notification.loginId && notification.loginId !== loginId)) {
      return Effect.void;
    }
    return notification.success
      ? Deferred.succeed(completion, undefined)
      : Deferred.fail(
          completion,
          codexAuthenticationError(
            notification.error?.trim() || "OpenAI did not complete the Codex sign-in.",
          ),
        );
  });

  return {
    start: () =>
      runPromise(
        client.startDeviceLogin.pipe(
          Effect.mapError((cause) =>
            codexAuthenticationError(CODEX_DEVICE_LOGIN_START_ERROR, cause),
          ),
          Effect.flatMap(
            (result): Effect.Effect<CodexDeviceLoginResult, ProviderAuthenticationError> =>
              result.type === "chatgptDeviceCode"
                ? Effect.succeed(result)
                : Effect.fail(
                    codexAuthenticationError(
                      "This Codex version does not support device-code sign-in.",
                    ),
                  ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              loginId = result.loginId;
            }),
          ),
          Effect.map((result) => ({
            authorizationUrl: result.verificationUrl,
            state: result.loginId,
            completion: "browser" as const,
            userCode: result.userCode,
          })),
        ),
      ),
    complete: () => runPromise(Deferred.await(completion)),
    close: () => client.close(loginId),
  } satisfies ProviderAuthenticationQuery;
});

export const makeCodexAuthenticationClient = Effect.fn("makeCodexAuthenticationClient")(
  function* (input: {
    readonly settings: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const authenticationScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(authenticationScope, Exit.void));

    const resolvedHomePath = input.settings.homePath
      ? expandHomePath(input.settings.homePath)
      : undefined;
    const environment = {
      ...input.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const spawnCommand = yield* resolveSpawnCommand(
      input.settings.binaryPath,
      codexAppServerArgs(input.settings.launchArgs),
      { env: environment, extendEnv: true },
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.cwd,
          env: environment,
          extendEnv: true,
          forceKillAfter: CODEX_AUTH_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, authenticationScope),
        Effect.mapError((cause) =>
          codexAuthenticationError("Codex sign-in could not initialize.", cause),
        ),
      );
    const clientContext = yield* Layer.buildWithScope(
      CodexClient.layerChildProcess(child),
      authenticationScope,
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    yield* client.request("initialize", buildCodexInitializeParams()).pipe(
      Effect.andThen(client.notify("initialized", undefined)),
      Effect.mapError((cause) =>
        codexAuthenticationError("Codex sign-in could not initialize.", cause),
      ),
    );

    return {
      startDeviceLogin: client.request("account/login/start", { type: "chatgptDeviceCode" }),
      onLoginCompleted: (handler) =>
        client.handleServerNotification("account/login/completed", handler),
      close: (loginId) => {
        const cancel = loginId
          ? client
              .request("account/login/cancel", { loginId })
              .pipe(Effect.timeoutOption(Duration.seconds(1)), Effect.ignore)
          : Effect.void;
        runFork(cancel.pipe(Effect.ensuring(Scope.close(authenticationScope, Exit.void))));
      },
    } satisfies CodexAuthenticationClient;
  },
);
