import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { CommandId, ProjectId } from "@spiritdevs/contracts";
import { MembershipId } from "@spiritdevs/contracts/company";

import {
  resolveAvailableEditorsForConfig,
  refreshLocalGitStatusAfterMutation,
  resolveIssueConnectionActor,
  wsProjectUpdateInputFromMutation,
} from "./ws.ts";

it.effect("waits for local Git status before completing a ref mutation", () =>
  Effect.gen(function* () {
    const refreshStarted = yield* Deferred.make<void>();
    const releaseRefresh = yield* Deferred.make<void>();
    const mutationResult = { refName: "feature/selected" };

    const mutationFiber = yield* refreshLocalGitStatusAfterMutation(
      "/repo",
      Effect.succeed(mutationResult),
      () =>
        Deferred.succeed(refreshStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRefresh)),
        ),
    ).pipe(Effect.forkChild);

    yield* Deferred.await(refreshStarted);
    assert.isUndefined(mutationFiber.pollUnsafe());

    yield* Deferred.succeed(releaseRefresh, undefined);
    assert.deepStrictEqual(yield* Fiber.join(mutationFiber), mutationResult);
  }),
);

it.effect("bounds the local Git status wait without cancelling the refresh", () =>
  Effect.gen(function* () {
    const refreshStarted = yield* Deferred.make<void>();
    const releaseRefresh = yield* Deferred.make<void>();
    const refreshCompleted = yield* Deferred.make<void>();
    const mutationResult = { refName: "feature/selected" };

    const mutationFiber = yield* refreshLocalGitStatusAfterMutation(
      "/repo",
      Effect.succeed(mutationResult),
      () =>
        Deferred.succeed(refreshStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRefresh)),
          Effect.andThen(Deferred.succeed(refreshCompleted, undefined)),
        ),
      Duration.seconds(2),
    ).pipe(Effect.forkChild);

    yield* Deferred.await(refreshStarted);
    yield* TestClock.adjust(Duration.seconds(2));

    assert.deepStrictEqual(yield* Fiber.join(mutationFiber), mutationResult);
    assert.isFalse(yield* Deferred.isDone(refreshCompleted));

    yield* Deferred.succeed(releaseRefresh, undefined);
    yield* Deferred.await(refreshCompleted);
  }),
);

it.each(["worktree" as const, null])(
  "forwards the project workspace override through WebSocket RPC: %s",
  (defaultThreadEnvMode) => {
    const commandId = CommandId.make("command:ws-project-workspace");
    const projectId = ProjectId.make("project:ws-mutation");
    assert.deepEqual(
      wsProjectUpdateInputFromMutation({
        type: "project.update",
        commandId,
        projectId,
        defaultThreadEnvMode,
      }),
      { commandId, projectId, defaultThreadEnvMode },
    );
  },
);

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

it.effect(
  "attributes cloud sessions to their replica membership and preserves legacy fallback",
  () =>
    Effect.gen(function* () {
      const member = { kind: "member" as const, membershipId: MembershipId.make("membership-1") };
      const tracker = {
        linkedMemberActor: Effect.succeed(member),
        memberActorForCloudUserId: (userId: string) =>
          Effect.succeed(userId === "user-1" ? member : null),
      };
      assert.deepEqual(
        yield* resolveIssueConnectionActor({ subject: "cloud-connect" }, tracker),
        member,
      );
      assert.deepEqual(yield* resolveIssueConnectionActor({ subject: "user-1" }, tracker), member);
      assert.deepEqual(
        yield* resolveIssueConnectionActor({ subject: "desktop-bootstrap" }, tracker),
        {
          kind: "user",
        },
      );
    }),
);
