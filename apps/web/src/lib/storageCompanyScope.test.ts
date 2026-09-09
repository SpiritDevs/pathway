import {
  DEFAULT_STORAGE_POLICY,
  EnvironmentId,
  ThreadId,
  type StorageSnapshot,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";
import { companyScopedStorageSnapshot } from "./storageCompanyScope";

const environmentId = EnvironmentId.make("environment-one");
const companyId = CompanyId.make("company-one");
const otherCompanyId = CompanyId.make("company-two");
const registration = {
  entityKind: "environmentRegistration",
  id: "registration-one",
  environmentId,
  publicKeyThumbprint: "thumbprint",
  descriptor: {
    environmentId,
    applicationId: "pathway",
    label: "This Mac",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "2026.8.0",
    capabilities: { repositoryIdentity: true },
  },
  relayLinkState: "linked",
  managedEndpointAvailable: true,
  lastSeenAt: 1000,
  serviceRoleIds: [],
  teamIds: [],
  state: "active",
  registeredByMembershipId: null,
  createdAt: 1000,
  updatedAt: 2000,
};
const binding = {
  entityKind: "environmentBinding",
  id: "binding-one",
  cloudProjectId: "cloud-project-one",
  environmentId,
  localProjectId: "project-one",
  localWorkspaceRoot: "/work/project",
  repositoryIdentity: null,
  status: "active",
  lastSeenAt: 2000,
  createdAt: 1000,
  updatedAt: 2000,
};
const ownedConversation = {
  threadId: ThreadId.make("conversation-one"),
  title: "Private conversation",
  projectId: null,
  conversationCompanyId: companyId,
  worktreeId: "/conversation/one",
  status: "settled" as const,
  keepWorktree: false,
  threadDataBytes: 50,
  eligibleSince: null,
  reclaimedAt: null,
};
const foreignConversation = {
  ...ownedConversation,
  threadId: ThreadId.make("conversation-two"),
  conversationCompanyId: otherCompanyId,
  worktreeId: "/conversation/two",
};
const orphan = {
  id: "/work/old",
  path: "/work/old",
  projectRoot: "/work/project",
  branch: "old-work",
  volumeId: "disk",
  threadIds: [],
  estimatedBytes: 500,
  measuredAt: null,
  kind: "orphan" as const,
  blockers: [],
  removed: false,
};
const snapshot: StorageSnapshot = {
  sampledAt: "2026-09-09T00:00:00Z",
  policy: DEFAULT_STORAGE_POLICY,
  scanError: null,
  volumes: [
    {
      id: "disk",
      path: "/",
      totalBytes: 1000,
      availableBytes: 500,
      sampledAt: "2026-09-09T00:00:00Z",
      pressure: "healthy",
    },
  ],
  threads: [ownedConversation, foreignConversation],
  worktrees: [
    orphan,
    { ...orphan, id: "/foreign/old", path: "/foreign/old", projectRoot: "/foreign/project" },
  ],
  jobs: [
    {
      id: "job",
      mode: "manual",
      status: "completed",
      startedAt: "2026-09-09T00:00:00Z",
      finishedAt: null,
      items: [
        {
          worktreeId: orphan.id,
          status: "removed",
          message: null,
          estimatedBytes: 500,
          actualFreeDeltaBytes: 500,
        },
        {
          worktreeId: "/foreign/old",
          status: "failed",
          message: "Foreign private path",
          estimatedBytes: 500,
          actualFreeDeltaBytes: null,
        },
      ],
    },
  ],
};
function replica(...values: unknown[]) {
  return { view: new Map(values.map((value, index) => [String(index), value])) };
}

describe("storage dashboard company scope", () => {
  it("includes an owned projectless conversation before its cloud thread replica arrives", () => {
    const scoped = companyScopedStorageSnapshot(
      snapshot,
      companyId,
      new Map([[companyId, replica(registration)]]),
      environmentId,
    );
    expect(scoped.threads.map((thread) => thread.threadId)).toEqual([ownedConversation.threadId]);
    expect(scoped.volumes).toBe(snapshot.volumes);
  });
  it("hides conversation details until the company has an active environment registration", () => {
    expect(
      companyScopedStorageSnapshot(snapshot, companyId, new Map(), environmentId).threads,
    ).toEqual([]);
    expect(
      companyScopedStorageSnapshot(
        snapshot,
        companyId,
        new Map([[companyId, replica({ ...registration, state: "revoked" })]]),
        environmentId,
      ).threads,
    ).toEqual([]);
  });
  it("shows orphaned worktrees for the selected company's project bindings and scopes cleanup history", () => {
    const scoped = companyScopedStorageSnapshot(
      snapshot,
      companyId,
      new Map([[companyId, replica(registration, binding)]]),
      environmentId,
    );
    expect(scoped.worktrees.map((worktree) => worktree.id)).toEqual([orphan.id]);
    expect(scoped.jobs[0]?.items.map((item) => item.worktreeId)).toEqual([orphan.id]);
  });
  it("keeps cleanup history for a removed orphan using its recorded project root", () => {
    const removed = {
      ...snapshot,
      worktrees: [],
      jobs: snapshot.jobs.map((job) => ({
        ...job,
        items: job.items.map((item) => ({
          ...item,
          projectRoot: item.worktreeId === orphan.id ? "/work/project" : "/foreign/project",
        })),
      })),
    };
    const scoped = companyScopedStorageSnapshot(
      removed,
      companyId,
      new Map([[companyId, replica(registration, binding)]]),
      environmentId,
    );
    expect(scoped.jobs[0]?.items.map((item) => item.worktreeId)).toEqual([orphan.id]);
  });
  it("combines authorized projectless conversations when all companies are selected", () => {
    const scoped = companyScopedStorageSnapshot(
      snapshot,
      null,
      new Map([
        [companyId, replica(registration)],
        [otherCompanyId, replica(registration)],
      ]),
      environmentId,
    );
    expect(scoped.threads).toHaveLength(2);
    expect(scoped.worktrees).toHaveLength(2);
  });
});
