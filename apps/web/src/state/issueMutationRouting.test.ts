import { setManagedRelaySession } from "@spiritdevs/client-runtime/relay";
import {
  createAtomCommandScheduler,
  type AtomCommand,
} from "@spiritdevs/client-runtime/state/runtime";
import { issueSyncOperation, type SyncEnqueueReceipt } from "@spiritdevs/client-runtime/sync";
import { LocalSequence, SyncEntityId } from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import { EnvironmentId, IssueId, IssueStatusId } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { activeCompanyIdAtom } from "../cloud/activeCompany";
import { companyRegistryReplicasAtom } from "../cloud/companyRegistryReplica";
import {
  companySyncEngineHandlesAtom,
  type CompanySyncEngineMutationHandle,
} from "../cloud/companySyncEngines";
import { IssueSyncUnavailableError } from "../cloud/issueDomainMutations";
import { cloudSyncTabStateAtom } from "../cloud/syncStatus";
import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { IssueMutationRoutingError, routeIssueMutationCommand } from "./issueMutationRouting";

const COMPANY_ID = CompanyId.make("company-a");
const COMPANY_B_ID = CompanyId.make("company-b");
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
            ["issue:issue-a", { entityKind: "issue", id: ISSUE_ID }],
          ]),
        },
      ],
    ]),
  );
}

function publishAllReplicas(): void {
  appAtomRegistry.set(
    companyRegistryReplicasAtom,
    new Map([
      [
        COMPANY_ID,
        {
          view: new Map([
            ["company:company-a", { entityKind: "company", name: "Acme", issueKeyPrefix: "ACME" }],
            ["issue:issue-a", { entityKind: "issue", id: ISSUE_ID }],
          ]),
        },
      ],
      [
        COMPANY_B_ID,
        {
          view: new Map([
            ["company:company-b", { entityKind: "company", name: "Beta", issueKeyPrefix: "BETA" }],
            ["issue:issue-b", { entityKind: "issue", id: "issue-b" }],
            ["issueStatus:status-b", { entityKind: "issueStatus", id: "status-b" }],
          ]),
        },
      ],
    ]),
  );
  appAtomRegistry.set(activeCompanyIdAtom, null);
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
    sync: Effect.die("sync is not used by this test"),
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

  it("routes existing entities from All companies to their owning engines", async () => {
    publishAllReplicas();
    const fakeA = fakeHandle();
    const fakeB = fakeHandle();
    appAtomRegistry.set(
      companySyncEngineHandlesAtom,
      new Map([
        [COMPANY_ID, fakeA.handle],
        [COMPANY_B_ID, fakeB.handle],
      ]),
    );
    const deleteB = issueSyncOperation({
      kind: "issue.delete",
      entityId: SyncEntityId.make("issue-b"),
      args: {},
    });
    const legacy = legacyCommand();
    const command = routeIssueMutationCommand(legacy.command, {
      scheduler: createAtomCommandScheduler(),
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      plan: () => ({ operations: [DELETE_ISSUE, deleteB], result: () => "sync" }),
    });

    const result = await command.run(appAtomRegistry, {
      environmentId: ENVIRONMENT_ID,
      input: { issueId: ISSUE_ID },
    });

    expect(AsyncResult.isSuccess(result) && result.value).toBe("sync");
    expect(fakeA.inputs.map(({ operation }) => operation)).toEqual([DELETE_ISSUE]);
    expect(fakeB.inputs.map(({ operation }) => operation)).toEqual([deleteB]);
  });

  it("preflights every destination before enqueueing a multi-company write", async () => {
    publishAllReplicas();
    const fakeA = fakeHandle();
    appAtomRegistry.set(companySyncEngineHandlesAtom, new Map([[COMPANY_ID, fakeA.handle]]));
    const deleteB = issueSyncOperation({
      kind: "issue.delete",
      entityId: SyncEntityId.make("issue-b"),
      args: {},
    });
    const legacy = legacyCommand();
    const command = routeIssueMutationCommand(legacy.command, {
      scheduler: createAtomCommandScheduler(),
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      plan: () => ({ operations: [DELETE_ISSUE, deleteB], result: () => "sync" }),
    });

    const result = await command.run(appAtomRegistry, {
      environmentId: ENVIRONMENT_ID,
      input: { issueId: ISSUE_ID },
    });

    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({
        _tag: "IssueSyncUnavailableError",
        companyId: COMPANY_B_ID,
        reason: "no-engine",
      });
    }
    expect(fakeA.inputs).toHaveLength(0);
  });

  it("rejects an ambiguous top-level create in All companies", async () => {
    publishAllReplicas();
    const create = issueSyncOperation({
      kind: "issue.create",
      entityId: SyncEntityId.make("new-issue"),
      args: { title: "New issue" },
    });
    const legacy = legacyCommand();
    const command = routeIssueMutationCommand(legacy.command, {
      scheduler: createAtomCommandScheduler(),
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      plan: () => ({ operations: [create], result: () => "sync" }),
    });

    const result = await command.run(appAtomRegistry, {
      environmentId: ENVIRONMENT_ID,
      input: { issueId: ISSUE_ID },
    });

    expect(legacy.run).not.toHaveBeenCalled();
    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({
        _tag: "IssueMutationRoutingError",
        reason: "ambiguous-company",
      });
      expect(Cause.squash(result.cause)).toBeInstanceOf(IssueMutationRoutingError);
    }
  });

  it("rejects cross-company workflow references before enqueueing", async () => {
    publishAllReplicas();
    const fakeA = fakeHandle();
    const fakeB = fakeHandle();
    appAtomRegistry.set(
      companySyncEngineHandlesAtom,
      new Map([
        [COMPANY_ID, fakeA.handle],
        [COMPANY_B_ID, fakeB.handle],
      ]),
    );
    const update = issueSyncOperation({
      kind: "issue.update",
      entityId: SyncEntityId.make(ISSUE_ID),
      args: { statusId: IssueStatusId.make("status-b") },
    });
    const legacy = legacyCommand();
    const command = routeIssueMutationCommand(legacy.command, {
      scheduler: createAtomCommandScheduler(),
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      plan: () => ({ operations: [update], result: () => "sync" }),
    });

    const result = await command.run(appAtomRegistry, {
      environmentId: ENVIRONMENT_ID,
      input: { issueId: ISSUE_ID },
    });

    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({
        reason: "cross-company-reference",
      });
    }
    expect(fakeA.inputs).toHaveLength(0);
    expect(fakeB.inputs).toHaveLength(0);
  });
});
