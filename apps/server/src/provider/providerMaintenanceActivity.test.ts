import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";

import { make } from "./providerMaintenanceActivity.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

describe("provider maintenance activity", () => {
  it.effect("waits for every resident session of a driver, including sibling instances", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const activity = yield* make;
        const personal = yield* Scope.make();
        const work = yield* Scope.make();
        yield* activity.acquireUse(codex).pipe(Effect.provideService(Scope.Scope, personal));
        yield* activity.acquireUse(codex).pipe(Effect.provideService(Scope.Scope, work));
        const update = yield* activity
          .whenIdle(codex, Effect.succeed("updated"))
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.isUndefined(update.pollUnsafe());
        yield* Scope.close(personal, Exit.void);
        yield* Effect.yieldNow;
        assert.isUndefined(update.pollUnsafe());
        yield* Scope.close(work, Exit.void);
        assert.equal(yield* Fiber.join(update), "updated");
      }),
    ),
  );

  it.effect("keeps other providers available and makes new jobs wait during an update", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const activity = yield* make;
        const installing = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const update = yield* activity
          .whenIdle(
            codex,
            Deferred.succeed(installing, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(installing);
        const newJob = yield* activity
          .withUse(codex, Effect.succeed("new version"))
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.isUndefined(newJob.pollUnsafe());
        assert.equal(yield* activity.withUse(claude, Effect.succeed("available")), "available");
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(update);
        assert.equal(yield* Fiber.join(newJob), "new version");
      }),
    ),
  );

  it.effect("waits for one-shot jobs and releases usage after cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const activity = yield* make;
        const started = yield* Deferred.make<void>();
        const job = yield* activity
          .withUse(codex, Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const update = yield* activity
          .whenIdle(codex, Effect.succeed("updated"))
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.isUndefined(update.pollUnsafe());
        yield* Fiber.interrupt(job);
        assert.equal(yield* Fiber.join(update), "updated");
        yield* activity.whenIdle(codex, Effect.fail("failed")).pipe(Effect.ignore);
        assert.equal(yield* activity.withUse(codex, Effect.succeed("available")), "available");
      }),
    ),
  );
});
