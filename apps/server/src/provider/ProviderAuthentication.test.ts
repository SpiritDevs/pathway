import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  makeProviderAuthentication,
  type ProviderAuthenticationQuery,
} from "./ProviderAuthentication.ts";

it.layer(NodeServices.layer)("ProviderAuthentication", (it) => {
  it.effect("completes a manual Claude OAuth flow without exposing terminal UI", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const completions: Array<{ authorizationCode: string; state: string }> = [];
        let closeCount = 0;
        const query: ProviderAuthenticationQuery = {
          start: async () => ({
            authorizationUrl:
              "https://claude.com/cai/oauth/authorize?state=oauth-state&code=challenge",
            state: "oauth-state",
          }),
          complete: async (authorizationCode, state) => {
            completions.push({ authorizationCode, state });
          },
          close: () => {
            closeCount += 1;
          },
        };
        const authentication = yield* makeProviderAuthentication(Effect.succeed(query), {
          providerName: "Claude",
          allowedAuthorizationHosts: new Set(["claude.com"]),
        });

        const started = yield* authentication.start;
        yield* authentication.complete({
          flowId: started.flowId,
          authorizationCode: "  authorization-code  ",
        });

        assert.match(started.authorizationUrl, /^https:\/\/claude\.com\/cai\/oauth\/authorize/u);
        assert.deepStrictEqual(completions, [
          { authorizationCode: "authorization-code", state: "oauth-state" },
        ]);
        assert.strictEqual(closeCount, 1);
      }),
    ),
  );

  it.effect("rejects untrusted authorization URLs and closes their query", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closed = false;
        const authentication = yield* makeProviderAuthentication(
          Effect.succeed({
            start: async () => ({
              authorizationUrl: "https://example.com/oauth?state=oauth-state",
              state: "oauth-state",
            }),
            complete: async () => {},
            close: () => {
              closed = true;
            },
          }),
          {
            providerName: "Claude",
            allowedAuthorizationHosts: new Set(["claude.com"]),
          },
        );

        const result = yield* Effect.result(authentication.start);

        assert.isTrue(result._tag === "Failure");
        assert.isTrue(closed);
      }),
    ),
  );

  it.effect("supports browser-completed device-code flows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const completions: Array<{ authorizationCode: string; state: string }> = [];
        const authentication = yield* makeProviderAuthentication(
          Effect.succeed({
            start: async () => ({
              authorizationUrl: "https://auth.openai.com/codex/device",
              state: "login-id",
              completion: "browser" as const,
              userCode: "ABCD-EFGH",
            }),
            complete: async (authorizationCode, state) => {
              completions.push({ authorizationCode, state });
            },
            close: () => {},
          }),
          {
            providerName: "Codex",
            allowedAuthorizationHosts: new Set(["auth.openai.com"]),
          },
        );

        const started = yield* authentication.start;
        yield* authentication.complete({ flowId: started.flowId });

        assert.strictEqual(started.completion, "browser");
        assert.strictEqual(started.userCode, "ABCD-EFGH");
        assert.deepStrictEqual(completions, [{ authorizationCode: "", state: "login-id" }]);
      }),
    ),
  );
});
