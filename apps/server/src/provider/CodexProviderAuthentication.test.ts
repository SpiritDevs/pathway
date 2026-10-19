import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeCodexAuthenticationQuery,
  type CodexAuthenticationClient,
} from "./CodexProviderAuthentication.ts";
import { ProviderAuthenticationError } from "./ProviderAuthentication.ts";

it.effect("turns Codex device login into a browser-completed provider auth query", () =>
  Effect.gen(function* () {
    let closedLoginId: string | null = null;
    const loginCompletionHandlers: Array<
      (notification: {
        readonly loginId?: string | null;
        readonly success: boolean;
        readonly error?: string | null;
      }) => Effect.Effect<void>
    > = [];
    const client: CodexAuthenticationClient = {
      startDeviceLogin: Effect.succeed({
        type: "chatgptDeviceCode",
        loginId: "login-1",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/codex/device",
      }),
      onLoginCompleted: (handler) =>
        Effect.sync(() => {
          loginCompletionHandlers.push(handler);
        }),
      close: (loginId) => {
        closedLoginId = loginId;
      },
    };
    const query = yield* makeCodexAuthenticationQuery(client);

    const started = yield* Effect.tryPromise({
      try: () => query.start(),
      catch: (cause) =>
        new ProviderAuthenticationError({ reason: "Could not start test login.", cause }),
    });
    assert.deepStrictEqual(started, {
      authorizationUrl: "https://auth.openai.com/codex/device",
      state: "login-1",
      completion: "browser",
      userCode: "ABCD-EFGH",
    });

    const notifyLoginCompleted = loginCompletionHandlers[0];
    if (!notifyLoginCompleted) {
      return yield* new ProviderAuthenticationError({
        reason: "Expected a login completion handler.",
      });
    }
    yield* notifyLoginCompleted({ loginId: "login-1", success: true });
    yield* Effect.tryPromise({
      try: () => query.complete(),
      catch: (cause) =>
        new ProviderAuthenticationError({ reason: "Could not complete test login.", cause }),
    });
    query.close();

    assert.strictEqual(closedLoginId, "login-1");
  }),
);
