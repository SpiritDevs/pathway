import type { AtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import { type SyncCycleReceipt } from "@spiritdevs/client-runtime/sync";
import {
  EnvironmentId,
  IssueEnrichmentRunId,
  IssueId,
  IssueStatusId,
  ProjectId,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { AuthorizationEpoch, CompanyVersion, LocalSequence } from "@spiritdevs/contracts/cloudSync";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { companyRegistryReplicasAtom } from "../cloud/companyRegistryReplica";
import { companySyncEngineHandlesAtom } from "../cloud/companySyncEngines";
import { cloudSyncTabStateAtom } from "../cloud/syncStatus";
import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import {
  IssueTrackerUnavailableError,
  issueCommands,
  resolveIssueInvestigationTarget,
  routeIssueInvestigationCommand,
} from "./issues";

const COMPANY = CompanyId.make("company-investigation");
const ENVIRONMENT = EnvironmentId.make("environment-investigation");
const REMOTE = EnvironmentId.make("environment-remote-investigation");
const ISSUE = IssueId.make("cloud-only-task");
const PROJECT = ProjectId.make("local-project");
const REMOTE_PROJECT = ProjectId.make("remote-checkout");
const RECEIPT: SyncCycleReceipt = {
  outcome: "synced",
  cursor: CompanyVersion.make(1),
  authorizationEpoch: AuthorizationEpoch.make(1),
  appliedChanges: 0,
  acceptedOperations: 1,
  rejectedOperations: 0,
  error: null,
};

function publishReplica(
  revoked = false,
  projectId = "cloud-project",
  preferredBindingId = "local-binding",
) {
  const bindings = [
    {
      entityKind: "environmentBinding",
      id: "local-binding",
      cloudProjectId: "cloud-project",
      environmentId: ENVIRONMENT,
      localProjectId: PROJECT,
      localWorkspaceRoot: "/tmp/local",
      status: "active",
      lastSeenAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      entityKind: "environmentBinding",
      id: "remote-binding",
      cloudProjectId: "cloud-project",
      environmentId: REMOTE,
      localProjectId: REMOTE_PROJECT,
      localWorkspaceRoot: "/tmp/remote",
      status: "active",
      lastSeenAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    ...(revoked
      ? [
          {
            entityKind: "environmentBinding",
            id: "remote-revocation",
            cloudProjectId: "cloud-project",
            environmentId: REMOTE,
            localProjectId: REMOTE_PROJECT,
            localWorkspaceRoot: "/tmp/remote",
            status: "revoked",
            lastSeenAt: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        ]
      : []),
  ];
  appAtomRegistry.set(
    companyRegistryReplicasAtom,
    new Map([
      [
        COMPANY,
        {
          view: new Map<string, unknown>([
            [
              "issue:cloud-only-task",
              {
                entityKind: "issue",
                id: ISSUE,
                projectId,
                key: "COR-84",
                keyNumber: 84,
                title: "Cloud-only task",
                description: "",
                statusId: "cloud-status",
                priority: "medium",
                assignee: null,
                milestoneId: null,
                cycleId: null,
                parentId: null,
                sortOrder: "m",
                labelIds: [],
                dueDate: null,
                triage: false,
                slackSource: null,
                teamIds: [],
                workflowOwner: { kind: "company" },
                workModelSelection: null,
                automationAssignment: null,
                pullRequest: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            [
              "cloudProject:cloud-project",
              {
                entityKind: "cloudProject",
                id: "cloud-project",
                name: "Pathway",
                description: "",
                teamIds: [],
                defaultWorkflowOwner: null,
                preferredBindingId,
                archivedAt: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            [
              "issueStatus:cloud-status",
              {
                entityKind: "issueStatus",
                id: "cloud-status",
                scope: "company",
                teamId: null,
                baseStatusId: null,
                name: "Ready",
                color: "#123456",
                category: "unstarted",
                position: 0,
                hidden: false,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            ...bindings.map((binding) => [`environmentBinding:${binding.id}`, binding] as const),
          ]),
        },
      ],
    ]),
  );
}

function fakeCommand() {
  const run = vi.fn(async () => AsyncResult.success("started"));
  const command: AtomCommand<
    { environmentId: EnvironmentId; input: { issueId: IssueId } },
    string,
    Error
  > = { label: "test:investigate", run };
  return {
    run,
    command: routeIssueInvestigationCommand(command, (input: { issueId: IssueId }) => input, true),
  };
}

beforeEach(() => {
  resetAppAtomRegistryForTests();
  publishReplica();
  appAtomRegistry.set(cloudSyncTabStateAtom, { role: "leader", crossContext: true });
});

describe("cloud task investigation routing", () => {
  it("uses the owning company's binding even without a primary environment", () => {
    expect(resolveIssueInvestigationTarget(appAtomRegistry, ISSUE)).toEqual({
      environmentId: ENVIRONMENT,
      input: { route: { companyId: COMPANY, localProjectId: PROJECT } },
    });
    expect(
      resolveIssueInvestigationTarget(appAtomRegistry, ISSUE, {
        environmentId: REMOTE,
        localProjectId: REMOTE_PROJECT,
      }),
    ).toEqual({
      environmentId: REMOTE,
      input: { route: { companyId: COMPANY, localProjectId: REMOTE_PROJECT } },
    });
  });

  it("honors the detail pane's selected environment and checkout", () => {
    expect(
      resolveIssueInvestigationTarget(appAtomRegistry, ISSUE, {
        environmentId: REMOTE,
        localProjectId: REMOTE_PROJECT,
      }),
    ).toEqual({
      environmentId: REMOTE,
      input: { route: { companyId: COMPANY, localProjectId: REMOTE_PROJECT } },
    });
    publishReplica(true);
    expect(
      resolveIssueInvestigationTarget(appAtomRegistry, ISSUE, {
        environmentId: REMOTE,
        localProjectId: REMOTE_PROJECT,
      }),
    ).toBeInstanceOf(IssueTrackerUnavailableError);
  });

  it("uses the company's preferred environment unless the detail pane overrides it", () => {
    publishReplica(false, "cloud-project", "remote-binding");
    expect(resolveIssueInvestigationTarget(appAtomRegistry, ISSUE)).toEqual({
      environmentId: REMOTE,
      input: { route: { companyId: COMPANY, localProjectId: REMOTE_PROJECT } },
    });
    expect(
      resolveIssueInvestigationTarget(appAtomRegistry, ISSUE, {
        environmentId: ENVIRONMENT,
        localProjectId: PROJECT,
      }),
    ).toEqual({
      environmentId: ENVIRONMENT,
      input: { route: { companyId: COMPANY, localProjectId: PROJECT } },
    });
  });

  it("refuses a missing or ambiguous company instead of using the legacy tracker", () => {
    expect(
      resolveIssueInvestigationTarget(appAtomRegistry, IssueId.make("missing")),
    ).toBeInstanceOf(IssueTrackerUnavailableError);
    const replica = appAtomRegistry.get(companyRegistryReplicasAtom).get(COMPANY)!;
    appAtomRegistry.set(
      companyRegistryReplicasAtom,
      new Map([
        [COMPANY, replica],
        [CompanyId.make("another-company"), replica],
      ]),
    );
    expect(resolveIssueInvestigationTarget(appAtomRegistry, ISSUE)).toBeInstanceOf(
      IssueTrackerUnavailableError,
    );
  });

  it("waits for the cloud sync receipt before sending the routed start", async () => {
    const { run, command } = fakeCommand();
    let confirm!: (receipt: SyncCycleReceipt) => void;
    const confirmation = new Promise<SyncCycleReceipt>((resolve) => {
      confirm = resolve;
    });
    let entered!: () => void;
    const syncing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    appAtomRegistry.set(
      companySyncEngineHandlesAtom,
      new Map([
        [
          COMPANY,
          {
            enqueue: () => Effect.die("unused"),
            discardRejected: () => Effect.void,
            sync: Effect.tryPromise({
              try: () => {
                entered();
                return confirmation;
              },
              catch: () => {
                throw new Error("unexpected failure");
              },
            }),
          },
        ],
      ]),
    );
    const pending = command.run(appAtomRegistry, {
      issueId: ISSUE,
      selection: { environmentId: REMOTE, localProjectId: REMOTE_PROJECT },
    });
    await syncing;
    expect(run).not.toHaveBeenCalled();
    confirm(RECEIPT);
    expect(AsyncResult.isSuccess(await pending)).toBe(true);
    expect(run).toHaveBeenCalledWith(appAtomRegistry, {
      environmentId: REMOTE,
      input: { issueId: ISSUE, route: { companyId: COMPANY, localProjectId: REMOTE_PROJECT } },
    });
  });

  it.each(["offline", "failed", "disabled", "rejected"])(
    "does not start before an %s sync is confirmed",
    async (outcome) => {
      const { run, command } = fakeCommand();
      appAtomRegistry.set(
        companySyncEngineHandlesAtom,
        new Map([
          [
            COMPANY,
            {
              enqueue: () => Effect.die("unused"),
              discardRejected: () => Effect.void,
              sync: Effect.succeed({
                ...RECEIPT,
                ...(outcome === "rejected"
                  ? { rejectedOperations: 1 }
                  : { outcome: outcome as SyncCycleReceipt["outcome"] }),
              }),
            },
          ],
        ]),
      );
      expect(
        AsyncResult.isFailure(
          await command.run(appAtomRegistry, {
            issueId: ISSUE,
          }),
        ),
      ).toBe(true);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("routes legacy project aliases through their company binding", () => {
    publishReplica(false, PROJECT);
    expect(resolveIssueInvestigationTarget(appAtomRegistry, ISSUE)).toEqual({
      environmentId: ENVIRONMENT,
      input: { route: { companyId: COMPANY, localProjectId: PROJECT } },
    });
    expect(
      resolveIssueInvestigationTarget(appAtomRegistry, ISSUE, {
        environmentId: REMOTE,
        localProjectId: REMOTE_PROJECT,
      }),
    ).toEqual({
      environmentId: REMOTE,
      input: { route: { companyId: COMPANY, localProjectId: REMOTE_PROJECT } },
    });
  });

  it("keeps triage acceptance and refuses investigation until Cloud confirms the write", async () => {
    const order: string[] = [];
    appAtomRegistry.set(
      companySyncEngineHandlesAtom,
      new Map([
        [
          COMPANY,
          {
            enqueue: (input) =>
              Effect.sync(() => {
                order.push("enqueue");
                return {
                  accepted: true,
                  operationId: input.operationId,
                  localSequence: LocalSequence.make(1),
                  status: { _tag: "Pending" as const },
                };
              }),
            discardRejected: () => Effect.void,
            sync: Effect.sync(() => {
              order.push("sync");
              return { ...RECEIPT, outcome: "offline" as const };
            }),
          },
        ],
      ]),
    );
    const result = await issueCommands.triageAccept.run(appAtomRegistry, {
      environmentId: ENVIRONMENT,
      input: { issueId: ISSUE, statusId: IssueStatusId.make("cloud-status"), runEnrichment: true },
    });
    expect(AsyncResult.isSuccess(result)).toBe(true);
    if (!AsyncResult.isSuccess(result)) return;
    expect(result.value.issue.triage).toBe(false);
    expect(result.value.enrichmentRun).toBeNull();
    expect(result.value.enrichmentRefusal).toContain("could not be confirmed by Pathway Cloud");
    expect(order).toEqual(["enqueue", "sync"]);
  });

  it("routes cancellation to the selected checkout without requiring cloud writes", async () => {
    const runId = IssueEnrichmentRunId.make("investigation-run");
    const run = vi.fn(async () => AsyncResult.success("canceled"));
    const rpc: AtomCommand<
      { environmentId: EnvironmentId; input: { runId: IssueEnrichmentRunId } },
      string,
      Error
    > = { label: "test:cancel-investigation", run };
    const command = routeIssueInvestigationCommand(
      rpc,
      (input: { issueId: IssueId; runId: IssueEnrichmentRunId }) => ({ runId: input.runId }),
    );
    expect(
      AsyncResult.isSuccess(
        await command.run(appAtomRegistry, {
          issueId: ISSUE,
          runId,
          selection: { environmentId: REMOTE, localProjectId: REMOTE_PROJECT },
        }),
      ),
    ).toBe(true);
    expect(run).toHaveBeenCalledWith(appAtomRegistry, {
      environmentId: REMOTE,
      input: { runId, route: { companyId: COMPANY, localProjectId: REMOTE_PROJECT } },
    });
  });

  it("does not start when the company has no synchronization engine", async () => {
    const { run, command } = fakeCommand();
    expect(AsyncResult.isFailure(await command.run(appAtomRegistry, { issueId: ISSUE }))).toBe(
      true,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
