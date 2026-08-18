import type {
  CloudSyncEntity,
  IssueSyncOperation,
  SyncEngine,
} from "@spiritdevs/client-runtime/sync";
import { EnvironmentId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeCloudSyncEngineRegistry } from "./CloudSyncEngineRegistry.ts";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");
const ENVIRONMENT_ID = EnvironmentId.make("environment-a");

const engine = (companyId: CompanyId) =>
  ({ companyId }) as unknown as SyncEngine<CloudSyncEntity, IssueSyncOperation>;

describe("CloudSyncEngineRegistry", () => {
  it.effect("keeps an independent issue engine for every company", () =>
    Effect.gen(function* () {
      const registry = yield* makeCloudSyncEngineRegistry;
      const first = engine(COMPANY_A);
      const second = engine(COMPANY_B);

      yield* registry.registerIssueEngine({ environmentId: ENVIRONMENT_ID, engine: first });
      yield* registry.registerIssueEngine({ environmentId: ENVIRONMENT_ID, engine: second });

      expect((yield* registry.issueEngine(COMPANY_A))?.companyId).toBe(COMPANY_A);
      expect((yield* registry.issueEngine(COMPANY_B))?.companyId).toBe(COMPANY_B);
    }),
  );

  it.effect("does not let an old engine unregister its replacement", () =>
    Effect.gen(function* () {
      const registry = yield* makeCloudSyncEngineRegistry;
      const oldEngine = engine(COMPANY_A);
      const replacement = engine(COMPANY_A);

      yield* registry.registerIssueEngine({ environmentId: ENVIRONMENT_ID, engine: oldEngine });
      yield* registry.registerIssueEngine({ environmentId: ENVIRONMENT_ID, engine: replacement });
      yield* registry.unregisterIssueEngine({ engine: oldEngine });

      expect(yield* registry.issueEngine(COMPANY_A)).not.toBeNull();
      yield* registry.unregisterIssueEngine({ engine: replacement });
      expect(yield* registry.issueEngine(COMPANY_A)).toBeNull();
    }),
  );

  it.effect("removes an acquired engine when its use is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeCloudSyncEngineRegistry;
        const held = engine(COMPANY_A);
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkScoped(
          registry.withIssueEngine(
            { environmentId: ENVIRONMENT_ID, engine: held },
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );

        yield* Deferred.await(started);
        expect(yield* registry.issueEngine(COMPANY_A)).not.toBeNull();
        yield* Fiber.interrupt(fiber);
        expect(yield* registry.issueEngine(COMPANY_A)).toBeNull();
      }),
    ),
  );
});
