import { assert, describe, it } from "@effect/vitest";
import { CloudProjectId, EnvironmentCommandId, EnvironmentId } from "@spiritdevs/contracts";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";

import type { ConvexClientLike } from "./convexSyncTransport.ts";
import {
  EnvironmentCommandIssueFailedError,
  issueEnvironmentCommand,
  type EnvironmentCommandIssueInput,
} from "./remoteDispatch.ts";

const command: EnvironmentCommandIssueInput = {
  companyId: "company-one",
  id: EnvironmentCommandId.make("remote-build-command"),
  targetEnvironmentId: EnvironmentId.make("mac-pro"),
  cloudProjectId: CloudProjectId.make("pathway"),
  kind: "startThread",
  args: { kind: "startThread", prompt: "Build TestFlight", modelSelection: null },
  ttlMs: 60_000,
};

function harness(failures: readonly Error[] = []) {
  let token = "first-service-token";
  let auth = "";
  const invalidated: string[] = [];
  const calls: { auth: string; name: string; args: unknown }[] = [];
  const client: ConvexClientLike = {
    setAuth: (value) => {
      auth = value;
    },
    query: () => Promise.reject(new Error("Issuing a command does not query Convex")),
    mutation: (async (reference, args) => {
      calls.push({ auth, name: getFunctionName(reference), args });
      const failure = failures[calls.length - 1];
      if (failure !== undefined) throw failure;
      return null;
    }) as ConvexClientLike["mutation"],
  };
  return {
    calls,
    invalidated,
    issue: issueEnvironmentCommand(command, {
      convexUrl: "https://example.convex.cloud",
      client,
      tokens: {
        token: Effect.sync(() => token),
        invalidate: (stale) =>
          Effect.sync(() => {
            invalidated.push(stale ?? "");
            token = "fresh-service-token";
          }),
      },
    }),
  };
}

describe("environment command issuer", () => {
  it.effect("issues the target and project unchanged with environment service authentication", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* test.issue;
      assert.deepEqual(test.calls, [
        {
          auth: "first-service-token",
          name: "environmentCommands:issue",
          args: command,
        },
      ]);
      assert.deepEqual(test.invalidated, []);
    }),
  );

  it.effect("refreshes expired authentication once and reuses the idempotency id", () =>
    Effect.gen(function* () {
      const test = harness([
        new ConvexError({ code: "not-authenticated", message: "Expired token" }),
      ]);
      yield* test.issue;
      assert.deepEqual(
        test.calls.map((call) => call.auth),
        ["first-service-token", "fresh-service-token"],
      );
      assert.deepEqual(
        test.calls.map((call) => call.args),
        [command, command],
      );
      assert.deepEqual(test.invalidated, ["first-service-token"]);
    }),
  );

  it.effect("surfaces a missing service permission without retrying it", () =>
    Effect.gen(function* () {
      const refusal = new ConvexError({
        code: "permission-denied",
        message: "Missing permission remoteAgents.dispatch.",
      });
      const test = harness([refusal]);
      const error = yield* test.issue.pipe(Effect.flip);
      assert.instanceOf(error, EnvironmentCommandIssueFailedError);
      assert.include(error.message, "Missing permission remoteAgents.dispatch");
      assert.equal(error.cause, refusal);
      assert.lengthOf(test.calls, 1);
      assert.deepEqual(test.invalidated, []);
    }),
  );

  it.effect("stops after a fresh service token is also rejected", () =>
    Effect.gen(function* () {
      const refusal = new ConvexError({
        code: "not-authenticated",
        message: "Invalid service token",
      });
      const test = harness([refusal, refusal]);
      const error = yield* test.issue.pipe(Effect.flip);
      assert.include(error.message, "Invalid service token");
      assert.lengthOf(test.calls, 2);
      assert.deepEqual(test.invalidated, ["first-service-token"]);
    }),
  );
});
