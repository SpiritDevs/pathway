import { setManagedRelaySession } from "@spiritdevs/client-runtime/relay";
import {
  createAtomCommandScheduler,
  type AtomCommand,
} from "@spiritdevs/client-runtime/state/runtime";
import { issueSyncOperation, type SyncEnqueueReceipt } from "@spiritdevs/client-runtime/sync";
import { LocalSequence, SyncEntityId } from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import { EnvironmentId, IssueId } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { companyRegistryReplicasAtom } from "../cloud/companyRegistryReplica";
import {
  companySyncEngineHandlesAtom,
  type CompanySyncEngineMutationHandle,
} from "../cloud/companySyncEngines";
import { IssueSyncUnavailableError } from "../cloud/issueDomainMutations";
import { cloudSyncTabStateAtom } from "../cloud/syncStatus";
import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { routeIssueMutationCommand } from "./issueMutationRouting";

const COMPANY_ID = CompanyId.make("company-a");
const ENVIRONMENT_ID = EnvironmentId.make("environment-a");
const ISSUE_ID = IssueId.make("issue-a");
const DELETE_ISSUE = issueSyncOperation({
  kind: "issue.delete",
  entityId: SyncEntityId.make(ISSUE_ID),
  args: {},
});

function legacyCommand(run = vi.fn(async () => AsyncResult.success("legacy"))) {
  const command: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: { readonly issueId: IssueId } },
    string,
    Error
  > = {
    label: "test:legacy-issue-delete",
    run,
  };
  return { command, run };
}

function routed(command: ReturnType<typeof legacyCommand>["command"]) {
  return routeIssueMutationCommand(command, {
    scheduler: createAtomCommandScheduler(),
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    plan: () => ({ operations: [DELETE_ISSUE], result: () => "sync" }),
  });
}

function publishReplica(): void {
  appAtomRegistry.set(
    companyRegistryReplicasAtom,
    new Map([
      [
        COMPANY_ID,
        {
          view: new Map([
            [
              "company:company-a",
              {
                entityKind: "company",
                name: "Acme",
                issueKeyPrefix: "ACME",
              },
            ],
          ]),
        },
      ],
    ]),
  );
}

function fakeHandle() {
  const inputs: Array<Parameters<CompanySyncEngineMutationHandle["enqueue"]>[0]> = [];
  const handle: CompanySyncEngineMutationHandle = {
    enqueue: (input) =>
      Effect.sync(() => {
        inputs.push(input);
        return {
          accepted: true,
          operationId: input.operationId,
          localSequence: LocalSequence.make(inputs.length),
          status: { _tag: "Pending" },
        } satisfies SyncEnqueueReceipt;
      }),
    discardRejected: () => Effect.void,
  };
  return { handle, inputs };
}

describe("routeIssueMutationCommand", () => {
  beforeEach(() => {
    resetAppAtomRegistryForTests();
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-a",
      readClerkToken: async () => "token",
    });
    appAtomRegistry.set(cloudSyncTabStateAtom, { role: "leader", crossContext: true });
  });

  it("runs the untouched legacy command when the active company has no replica", async () => {
    const legacy = legacyCommand();
    const result = await routed(legacy.command).run(appAtomRegistry, {
      environmentId: ENVIRONMENT_ID,
      input: { issueId: ISSUE_ID },
    });

    expect(legacy.run).toHaveBeenCalledOnce();
    expect(AsyncResult.isSuccess(result) && result.value).toBe("legacy");
  });

  it("enqueues into the active company engine and skips RPC when its replica is present", async () => {
    publishReplica();
    const fake = fakeHandle();
    appAtomRegistry.set(companySyncEngineHandlesAtom, new Map([[COMPANY_ID, fake.handle]]));
    const legacy = legacyCommand();

    const result = await routed(legacy.command).run(appAtomRegistry, {
      environmentId: ENVIRONMENT_ID,
      input: { issueId: ISSUE_ID },
    });

    expect(legacy.run).not.toHaveBeenCalled();
    expect(AsyncResult.isSuccess(result) && result.value).toBe("sync");
    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]?.operation).toEqual(DELETE_ISSUE);
    expect(fake.inputs[0]?.operationId).toEqual(expect.any(String));
  });

  it("settles enqueue failures into the same command failure channel", async () => {
    publishReplica();
    const legacy = legacyCommand();

    const result = await routed(legacy.command).run(appAtomRegistry, {
      environmentId: ENVIRONMENT_ID,
      input: { issueId: ISSUE_ID },
    });

    expect(legacy.run).not.toHaveBeenCalled();
    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) {
      expect(Cause.squash(result.cause)).toBeInstanceOf(IssueSyncUnavailableError);
    }
  });
});
