import { companyEntityCodec, type CompanySyncEntity } from "@spiritdevs/client-runtime/sync";
import { EnvironmentId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";
import { cloudEnvironmentProjectsAtom, cloudEnvironmentThreadsAtom } from "./agentThreadReadModel";

const COMPANY_ID = CompanyId.make("company-one");
const ENVIRONMENT_ID = EnvironmentId.make("environment-one");
const CLOUD_PROJECT_ID = "cloud-project-one";
const LOCAL_PROJECT_ID = "local-project-one";
const THREAD_ID = "thread-one";

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
});

describe("cloud Agent Thread read model", () => {
  beforeEach(() => {
    resetAppAtomRegistryForTests();
    appAtomRegistry.set(
      companyRegistryReplicasAtom,
      new Map([
        [
          COMPANY_ID,
          {
            view: new Map<string, CompanySyncEntity>([
              ["cloudProject:cloud-project-one", cloudProject],
              ["environmentBinding:binding-one", binding],
              ["agentThread:environment-one:thread-one", agentThread],
            ]),
          },
        ],
      ]),
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
});
