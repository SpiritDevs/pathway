import {
  issueSyncOperation,
  type SyncCycleReceipt,
  type SyncEnqueueReceipt,
} from "@spiritdevs/client-runtime/sync";
import { LocalSequence, SyncEntityId, SyncOperationId } from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach } from "vite-plus/test";

import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import {
  publishCompanySyncEngineHandle,
  type CompanySyncEngineMutationHandle,
} from "./companySyncEngines";
import {
  enqueueIssueOperation,
  enqueueIssueOperations,
  IssueSyncUnavailableError,
  syncIssueOperations,
} from "./issueDomainMutations";
import { cloudSyncTabStateAtom, publishCloudSyncTabState } from "./syncStatus";

const COMPANY_ID = CompanyId.make("company-a");
const ISSUE_ID = SyncEntityId.make("issue-a");
const DELETE_ISSUE = issueSyncOperation({
  kind: "issue.delete",
  entityId: ISSUE_ID,
  args: {},
});
const SYNC_RECEIPT = {
  outcome: "synced",
  appliedChanges: 1,
  acceptedOperations: 1,
  rejectedOperations: 0,
  error: null,
} as SyncCycleReceipt;

function makeFakeHandle() {
  const seen = new Map<SyncOperationId, LocalSequence>();
  const inputs: Array<Parameters<CompanySyncEngineMutationHandle["enqueue"]>[0]> = [];
  const handle: CompanySyncEngineMutationHandle = {
    enqueueBatch: (batch) => Effect.forEach(batch, (input) => handle.enqueue(input)),
    enqueue: (input) =>
      Effect.sync(() => {
        inputs.push(input);
        const known = seen.get(input.operationId);
        if (known !== undefined) {
          return {
            accepted: false,
            operationId: input.operationId,
            localSequence: known,
            status: { _tag: "Pending" },
          } satisfies SyncEnqueueReceipt;
        }
        const localSequence = LocalSequence.make(seen.size + 1);
        seen.set(input.operationId, localSequence);
        return {
          accepted: true,
          operationId: input.operationId,
          localSequence,
          status: { _tag: "Pending" },
        } satisfies SyncEnqueueReceipt;
      }),
    discardRejected: () => Effect.void,
    sync: Effect.succeed(SYNC_RECEIPT),
  };
  return { handle, inputs };
}

describe("enqueueIssueOperation", () => {
  beforeEach(() => {
    resetAppAtomRegistryForTests();
    appAtomRegistry.set(cloudSyncTabStateAtom, { role: "leader", crossContext: true });
  });

  it.effect("mints an operation id and returns the engine enqueue receipt", () =>
    Effect.gen(function* () {
      const fake = makeFakeHandle();
      yield* publishCompanySyncEngineHandle(COMPANY_ID, fake.handle);

      const receipt = yield* enqueueIssueOperation({
        companyId: COMPANY_ID,
        operation: DELETE_ISSUE,
      });

      expect(receipt.accepted).toBe(true);
      expect(receipt.operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(fake.inputs).toEqual([
        {
          operationId: receipt.operationId,
          operation: DELETE_ISSUE,
        },
      ]);
    }),
  );

  it.effect("passes a company batch with individual retry ids and dependencies", () =>
    Effect.gen(function* () {
      const fake = makeFakeHandle();
      const firstId = SyncOperationId.make("first");
      const secondId = SyncOperationId.make("second");
      const dependent = { ...DELETE_ISSUE, dependsOn: [firstId] };
      yield* publishCompanySyncEngineHandle(COMPANY_ID, fake.handle);
      const receipts = yield* enqueueIssueOperations(COMPANY_ID, [
        { operation: DELETE_ISSUE, operationId: firstId },
        { operation: dependent, operationId: secondId },
      ]);
      expect(receipts.map((receipt) => receipt.operationId)).toEqual([firstId, secondId]);
      expect(fake.inputs[1]).toEqual({
        operation: dependent,
        operationId: secondId,
        dependsOn: [firstId],
      });
      expect(yield* enqueueIssueOperations(COMPANY_ID, [])).toEqual([]);
      yield* publishCloudSyncTabState({ role: "follower", crossContext: true });
      expect(
        yield* Effect.flip(enqueueIssueOperations(COMPANY_ID, [{ operation: DELETE_ISSUE }])),
      ).toMatchObject({ reason: "not-leader" });
      expect(fake.inputs).toHaveLength(2);
    }),
  );

  it.effect("preserves an explicit retry id and returns the deduplicated receipt", () =>
    Effect.gen(function* () {
      const fake = makeFakeHandle();
      const operationId = SyncOperationId.make("operation-retry");
      yield* publishCompanySyncEngineHandle(COMPANY_ID, fake.handle);

      const first = yield* enqueueIssueOperation({
        companyId: COMPANY_ID,
        operation: DELETE_ISSUE,
        operationId,
      });
      const duplicate = yield* enqueueIssueOperation({
        companyId: COMPANY_ID,
        operation: DELETE_ISSUE,
        operationId,
      });

      expect(first).toMatchObject({ accepted: true, operationId, localSequence: 1 });
      expect(duplicate).toMatchObject({ accepted: false, operationId, localSequence: 1 });
      expect(fake.inputs).toHaveLength(2);
    }),
  );

  it.effect("fails explicitly when the leader has no engine for the company", () =>
    Effect.gen(function* () {
      yield* publishCloudSyncTabState({ role: "leader", crossContext: true });

      const error = yield* Effect.flip(
        enqueueIssueOperation({ companyId: COMPANY_ID, operation: DELETE_ISSUE }),
      );

      expect(error).toBeInstanceOf(IssueSyncUnavailableError);
      expect(error).toMatchObject({
        _tag: "IssueSyncUnavailableError",
        companyId: COMPANY_ID,
        reason: "no-engine",
      });
    }),
  );

  it.effect("waits for the engine's drain/flush/drain receipt", () =>
    Effect.gen(function* () {
      const fake = makeFakeHandle();
      yield* publishCompanySyncEngineHandle(COMPANY_ID, fake.handle);

      expect(yield* syncIssueOperations(COMPANY_ID)).toBe(SYNC_RECEIPT);
    }),
  );

  it.effect("distinguishes a follower tab from a leader missing one company engine", () =>
    Effect.gen(function* () {
      const fake = makeFakeHandle();
      yield* publishCompanySyncEngineHandle(COMPANY_ID, fake.handle);
      yield* publishCloudSyncTabState({ role: "follower", crossContext: true });

      const error = yield* Effect.flip(
        enqueueIssueOperation({ companyId: COMPANY_ID, operation: DELETE_ISSUE }),
      );

      expect(error).toMatchObject({ reason: "not-leader" });
      expect(fake.inputs).toEqual([]);
    }),
  );
});
