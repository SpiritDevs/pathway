import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { MembershipId } from "@spiritdevs/contracts/company";

import { resolveAvailableEditorsForConfig, resolveIssueConnectionActor } from "./ws.ts";

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
