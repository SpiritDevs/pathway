import { companyEntityCodec, type CompanySyncEntity } from "@spiritdevs/client-runtime/sync";
import { EnvironmentId, ProjectId, ThreadId } from "@spiritdevs/contracts";
import { AgentThreadId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";
import {
  cloudEnvironmentProjectsAtom,
  cloudEnvironmentProjectsFromReplicas,
  cloudEnvironmentThreadsAtom,
  cloudEnvironmentThreadsFromReplicas,
  companyScopedEnvironmentProjects,
  companyScopedEnvironmentSnapshot,
  companyScopedEnvironmentThreads,
} from "./agentThreadReadModel";

const COMPANY_ID = CompanyId.make("company-one");
const OTHER_COMPANY_ID = CompanyId.make("company-two");
const ENVIRONMENT_ID = EnvironmentId.make("environment-one");
const CLOUD_PROJECT_ID = "cloud-project-one";
const LOCAL_PROJECT_ID = "local-project-one";
const THREAD_ID = "thread-one";

type AgentThreadSyncEntity = Extract<CompanySyncEntity, { readonly entityKind: "agentThread" }>;
type CloudProjectSyncEntity = Extract<CompanySyncEntity, { readonly entityKind: "cloudProject" }>;

function entity(kind: "cloudProject" | "environmentBinding" | "agentThread", payload: unknown) {
  const codec = companyEntityCodec(kind);
  if (codec === null) throw new Error(`missing ${kind} codec`);
  return Option.getOrThrow(codec.decode(payload));
}

const cloudProject = entity("cloudProject", {
  id: CLOUD_PROJECT_ID,
  name: "Pathway",
  description: "",
  teamIds: [],
  defaultWorkflowOwner: null,
  preferredBindingId: null,
  archivedAt: null,
  createdAt: 1_000,
  updatedAt: 2_000,
});

const binding = entity("environmentBinding", {
  id: "binding-one",
  cloudProjectId: CLOUD_PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  localProjectId: LOCAL_PROJECT_ID,
  localWorkspaceRoot: "/work/pathway",
  status: "active",
  lastSeenAt: 2_000,
  createdAt: 1_000,
  updatedAt: 2_000,
});

const agentThread = entity("agentThread", {
  id: `${ENVIRONMENT_ID}:${THREAD_ID}`,
  environmentId: ENVIRONMENT_ID,
  cloudProjectId: CLOUD_PROJECT_ID,
  shell: {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: LOCAL_PROJECT_ID,
    title: "Remote work",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/work/pathway",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: THREAD_ID,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: {
      id: "message-one",
      role: "assistant",
      updatedAt: "2026-08-17T00:00:00.000Z",
    },
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 2,
    visibleItemCount: 2,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  },
  updatedAt: 2_000,
}) as AgentThreadSyncEntity;

const otherCloudProject = entity("cloudProject", {
  id: "cloud-project-two",
  name: "Other company project",
  description: "",
  teamIds: [],
  defaultWorkflowOwner: null,
  preferredBindingId: null,
  archivedAt: null,
  createdAt: 3_000,
  updatedAt: 4_000,
}) as CloudProjectSyncEntity;

const otherBinding = entity("environmentBinding", {
  id: "binding-two",
  cloudProjectId: "cloud-project-two",
  environmentId: ENVIRONMENT_ID,
  localProjectId: "local-project-two",
  localWorkspaceRoot: "/work/other",
  status: "active",
  lastSeenAt: 4_000,
  createdAt: 3_000,
  updatedAt: 4_000,
});

const otherAgentThread = {
  ...agentThread,
  id: AgentThreadId.make(`${ENVIRONMENT_ID}:thread-two`),
  environmentId: ENVIRONMENT_ID,
  cloudProjectId: otherCloudProject.id,
  shell: {
    ...agentThread.shell,
    id: ThreadId.make("thread-two"),
    projectId: ProjectId.make("local-project-two"),
    title: "Other company work",
    worktreePath: "/work/other",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make("thread-two"),
    },
  },
  updatedAt: 4_000,
} satisfies typeof agentThread;

function replica(...values: ReadonlyArray<CompanySyncEntity>) {
  return {
    view: new Map(values.map((value) => [`${value.entityKind}:${value.id}`, value] as const)),
  };
}

describe("cloud Agent Thread read model", () => {
  beforeEach(() => {
    resetAppAtomRegistryForTests();
    appAtomRegistry.set(
      companyRegistryReplicasAtom,
      new Map([[COMPANY_ID, replica(cloudProject, binding, agentThread)]]),
    );
  });

  it("maps a company project to its environment-local project and thread shell", () => {
    expect(appAtomRegistry.get(cloudEnvironmentProjectsAtom(ENVIRONMENT_ID))).toMatchObject([
      {
        id: LOCAL_PROJECT_ID,
        title: "Pathway",
        workspaceRoot: "/work/pathway",
      },
    ]);
    expect(appAtomRegistry.get(cloudEnvironmentThreadsAtom(ENVIRONMENT_ID))).toMatchObject([
      {
        id: THREAD_ID,
        projectId: LOCAL_PROJECT_ID,
        title: "Remote work",
        worktreePath: "/work/pathway",
        latestVisibleMessage: { id: "message-one", role: "assistant", text: "" },
      },
    ]);
  });

  it("uses the selected replica or every replica for company scope", () => {
    const companyOne = replica(cloudProject, binding, agentThread);
    const companyTwo = replica(otherCloudProject, otherBinding, otherAgentThread);
    const allCompanies = new Map([
      [COMPANY_ID, companyOne],
      [OTHER_COMPANY_ID, companyTwo],
    ]);
    const selectedCompany = new Map([[OTHER_COMPANY_ID, companyTwo]]);

    expect(
      cloudEnvironmentProjectsFromReplicas(allCompanies, ENVIRONMENT_ID).map(
        (project) => project.id,
      ),
    ).toEqual([LOCAL_PROJECT_ID, "local-project-two"]);
    expect(
      cloudEnvironmentThreadsFromReplicas(allCompanies, ENVIRONMENT_ID).map((thread) => thread.id),
    ).toEqual([THREAD_ID, "thread-two"]);

    expect(
      cloudEnvironmentProjectsFromReplicas(selectedCompany, ENVIRONMENT_ID).map(
        (project) => project.id,
      ),
    ).toEqual(["local-project-two"]);
    expect(
      cloudEnvironmentThreadsFromReplicas(selectedCompany, ENVIRONMENT_ID).map(
        (thread) => thread.id,
      ),
    ).toEqual(["thread-two"]);
  });

  it("keeps the newest settled shell when companies contain the same thread", () => {
    const staleActive = agentThread;
    const settledAt = DateTime.makeUnsafe("2026-08-17T00:02:00.000Z");
    const newestSettled = {
      ...agentThread,
      shell: {
        ...agentThread.shell,
        settledOverride: "settled" as const,
        settledAt,
        updatedAt: settledAt,
      },
      updatedAt: 3_000,
    } satisfies typeof agentThread;

    for (const replicas of [
      new Map([
        [COMPANY_ID, replica(staleActive)],
        [OTHER_COMPANY_ID, replica(newestSettled)],
      ]),
      new Map([
        [OTHER_COMPANY_ID, replica(newestSettled)],
        [COMPANY_ID, replica(staleActive)],
      ]),
    ]) {
      expect(cloudEnvironmentThreadsFromReplicas(replicas, ENVIRONMENT_ID)).toMatchObject([
        { id: THREAD_ID, settledOverride: "settled", settledAt },
      ]);
    }
  });

  it("keeps the newest active shell when companies contain the same thread", () => {
    const settledAt = DateTime.makeUnsafe("2026-08-17T00:02:00.000Z");
    const staleSettled = {
      ...agentThread,
      shell: {
        ...agentThread.shell,
        settledOverride: "settled" as const,
        settledAt,
        updatedAt: settledAt,
      },
      updatedAt: 3_000,
    } satisfies typeof agentThread;
    const activeAt = DateTime.makeUnsafe("2026-08-17T00:03:00.000Z");
    const newestActive = {
      ...agentThread,
      shell: {
        ...agentThread.shell,
        settledOverride: "active" as const,
        settledAt: null,
        updatedAt: activeAt,
      },
      updatedAt: 4_000,
    } satisfies typeof agentThread;

    for (const replicas of [
      new Map([
        [COMPANY_ID, replica(staleSettled)],
        [OTHER_COMPANY_ID, replica(newestActive)],
      ]),
      new Map([
        [OTHER_COMPANY_ID, replica(newestActive)],
        [COMPANY_ID, replica(staleSettled)],
      ]),
    ]) {
      expect(cloudEnvironmentThreadsFromReplicas(replicas, ENVIRONMENT_ID)).toMatchObject([
        { id: THREAD_ID, settledOverride: "active", settledAt: null },
      ]);
    }
  });

  it("filters connected environment snapshots without narrowing All companies", () => {
    const companyOne = replica(cloudProject, binding, agentThread);
    const companyTwo = replica(otherCloudProject, otherBinding, otherAgentThread);
    const replicas = new Map([
      [COMPANY_ID, companyOne],
      [OTHER_COMPANY_ID, companyTwo],
    ]);
    const projects = cloudEnvironmentProjectsFromReplicas(replicas, ENVIRONMENT_ID);
    const threads = cloudEnvironmentThreadsFromReplicas(replicas, ENVIRONMENT_ID);

    expect(companyScopedEnvironmentProjects(projects, null, replicas, ENVIRONMENT_ID)).toBe(
      projects,
    );
    expect(companyScopedEnvironmentThreads(threads, null, replicas, ENVIRONMENT_ID)).toBe(threads);
    expect(
      companyScopedEnvironmentProjects(projects, OTHER_COMPANY_ID, replicas, ENVIRONMENT_ID).map(
        (project) => project.id,
      ),
    ).toEqual(["local-project-two"]);
    expect(
      companyScopedEnvironmentThreads(threads, OTHER_COMPANY_ID, replicas, ENVIRONMENT_ID).map(
        (thread) => thread.id,
      ),
    ).toEqual(["thread-two"]);

    const archivedSnapshot = {
      schemaVersion: 1,
      snapshotSequence: 2,
      projects,
      threads,
    };
    expect(
      companyScopedEnvironmentSnapshot(
        archivedSnapshot,
        OTHER_COMPANY_ID,
        replicas,
        ENVIRONMENT_ID,
      ),
    ).toMatchObject({
      schemaVersion: 1,
      snapshotSequence: 2,
      projects: [{ id: "local-project-two" }],
      threads: [{ id: "thread-two" }],
    });
    expect(companyScopedEnvironmentSnapshot(archivedSnapshot, null, replicas, ENVIRONMENT_ID)).toBe(
      archivedSnapshot,
    );
  });
});
