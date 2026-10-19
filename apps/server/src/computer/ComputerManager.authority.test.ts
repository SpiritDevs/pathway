import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

it.layer(NodeServices.layer)("Computer authority", (it) => {
  it.effect(
    "restores archived admission without reviving work or an explicit user revocation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            actionSettleMs: 0,
          });
          yield* manager.setControlEnabled("fixture", false);
          yield* manager.handleThreadRemoved("fixture");
          yield* manager.handleThreadRestored("fixture");
          const revoked = yield* Effect.flip(manager.withAgentActivity("fixture", Effect.void));
          expect(revoked.message).toContain("revoked");
          yield* manager.setControlEnabled("fixture", true);
          expect(yield* manager.withAgentActivity("fixture", Effect.succeed("new call"))).toBe(
            "new call",
          );
        }),
      ),
  );

  it.effect("ignores an older turn ending after the same thread took a new lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ComputerManager.make({
          backend: new FakeComputerBackend(),
          actionSettleMs: 0,
        });
        yield* manager.withAgentActivity(
          "fixture",
          manager.click("fixture", { x: 5, y: 5 }),
          undefined,
          "turn-new",
        );
        yield* manager.releaseDesktopControl("fixture", "turn-old");
        expect(yield* Effect.flip(manager.click("other", { x: 5, y: 5 }))).toMatchObject({
          code: "computer_controlled_by_other_thread",
        });
        yield* manager.releaseDesktopControl("fixture", "turn-new");
        expect(yield* manager.click("other", { x: 5, y: 5 })).toBeDefined();
      }),
    ),
  );

  it.effect("revokes queued admission and aborts the active operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ComputerManager.make({
          backend: new FakeComputerBackend(),
          actionSettleMs: 0,
        });
        const entered = yield* Deferred.make<void>();
        const blocked = yield* Deferred.make<void>();
        const first = yield* manager
          .withAgentActivity(
            "fixture",
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(blocked);
              return "ended";
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        let workCalls = 0;
        const work = Effect.sync(() => {
          workCalls += 1;
          return "input";
        });
        const queued = yield* manager
          .withAgentActivity("fixture", work)
          .pipe(Effect.flip, Effect.forkScoped);
        // Let the queued call reach its admission wait before revoking.
        yield* Effect.yieldNow;
        yield* manager.setControlEnabled("fixture", false);
        yield* manager.setControlEnabled("fixture", true);
        yield* Deferred.succeed(blocked, undefined);
        // Synara's action ignores its abort signal and resolves; the port
        // interrupts an aborted operation, so the active call ends revoked.
        const aborted = yield* Effect.flip(Fiber.join(first));
        expect(aborted).toMatchObject({ controlRevoked: true });
        const rejected = yield* Fiber.join(queued);
        expect(rejected.message).toContain("revoked");
        expect(workCalls).toBe(0);
        expect(yield* manager.withAgentActivity("fixture", work)).toBe("input");
      }),
    ),
  );
});
