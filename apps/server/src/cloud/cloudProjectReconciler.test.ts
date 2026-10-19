import type { CloudSyncEntity } from "@spiritdevs/client-runtime/sync";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { CloudProjectId, EnvironmentBindingId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as ProcessRunner from "../processRunner.ts";
import {
  authoritativeEnvironmentRepositories,
  primaryGitRemoteName,
  reconcileAuthoritativeEnvironmentRepositories,
  reconcileAuthoritativeEnvironmentRepositoriesWithRetry,
  reconcileRevokedEnvironmentProjects,
  revokedEnvironmentProjects,
} from "./cloudProjectReconciler.ts";

const CURRENT = EnvironmentId.make("environment-current");

function binding(input: {
  readonly id: string;
  readonly environmentId?: string;
  readonly localProjectId: string;
  readonly status: "active" | "revoked";
  readonly updatedAt: number;
}): CloudSyncEntity {
  return {
    entityKind: "environmentBinding",
    id: EnvironmentBindingId.make(input.id),
    cloudProjectId: CloudProjectId.make("cloud-project"),
    environmentId: EnvironmentId.make(input.environmentId ?? CURRENT),
    localProjectId: ProjectId.make(input.localProjectId),
    localWorkspaceRoot: "/work/pathway",
    status: input.status,
    lastSeenAt: input.updatedAt,
    createdAt: 1,
    updatedAt: input.updatedAt,
  };
}

describe("cloud project deletion reconciliation", () => {
  it("selects only revoked bindings addressed to this environment", () => {
    expect(
      revokedEnvironmentProjects(
        [
          binding({
            id: "active",
            localProjectId: "active-project",
            status: "active",
            updatedAt: 2,
          }),
          binding({
            id: "other",
            environmentId: "environment-other",
            localProjectId: "other-project",
            status: "revoked",
            updatedAt: 3,
          }),
          binding({
            id: "deleted",
            localProjectId: "deleted-project",
            status: "revoked",
            updatedAt: 4,
          }),
        ],
        CURRENT,
      ),
    ).toEqual([
      {
        bindingId: "deleted",
        localProjectId: ProjectId.make("deleted-project"),
        updatedAt: 4,
      },
    ]);
  });

  it("deduplicates a local project by the newest revoked binding", () => {
    expect(
      revokedEnvironmentProjects(
        [
          binding({ id: "old", localProjectId: "project", status: "revoked", updatedAt: 2 }),
          binding({ id: "new", localProjectId: "project", status: "revoked", updatedAt: 5 }),
        ],
        CURRENT,
      ),
    ).toEqual([
      {
        bindingId: "new",
        localProjectId: ProjectId.make("project"),
        updatedAt: 5,
      },
    ]);
  });

  it.effect("force-deletes a live local project and settles its durable intent", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project");
      const dispatch = vi.fn(
        (_command: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0]) => Effect.void,
      );
      const projects = {
        snapshot: Effect.succeed({
          projects: [
            {
              id: projectId,
              title: "Pathway",
              workspaceRoot: "/work/pathway",
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-08-20T00:00:00.000Z",
              updatedAt: "2026-08-20T00:00:00.000Z",
              deletedAt: null,
            },
          ],
          updatedAt: "2026-08-20T00:00:00.000Z",
        }),
      } as unknown as ProjectService.ProjectService["Service"];
      const orchestration = {
        dispatch,
      } as unknown as OrchestrationEngineService["Service"];

      const reconciled = yield* reconcileRevokedEnvironmentProjects({
        companyId: CompanyId.make("company"),
        environmentId: CURRENT,
        revoked: [{ bindingId: "binding", localProjectId: projectId, updatedAt: 7 }],
        projects,
        orchestration,
      });

      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        type: "project.delete",
        projectId,
        force: true,
      });
      expect(reconciled).toEqual(["binding:7"]);
    }),
  );
});

describe("cloud project repository reconciliation", () => {
  const identity = {
    canonicalKey: "github.com/spiritdevs/pathway",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/SpiritDevs/pathway.git",
    },
    displayName: "spiritdevs/pathway",
  };

  it("selects the resolver-preferred fetch remote from a live Git listing", () => {
    expect(
      primaryGitRemoteName(
        "origin https://github.com/old/pathway.git (fetch)\nupstream https://github.com/other/pathway.git (fetch)\n",
      ),
    ).toEqual({ name: "upstream", exists: true });
  });

  it("joins an active binding to its project's authoritative repository", () => {
    const project: CloudSyncEntity = {
      entityKind: "cloudProject",
      id: CloudProjectId.make("cloud-project"),
      name: "Pathway",
      description: "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      repositoryIdentity: identity,
      repositoryIdentityAuthority: "merge",
      archivedAt: null,
      createdAt: 1,
      updatedAt: 8,
    };
    expect(
      authoritativeEnvironmentRepositories(
        [
          project,
          binding({ id: "binding", localProjectId: "project", status: "active", updatedAt: 5 }),
        ],
        CURRENT,
      ),
    ).toEqual([
      {
        bindingId: "binding",
        localProjectId: ProjectId.make("project"),
        repositoryIdentity: identity,
        updatedAt: 8,
      },
    ]);
  });

  it("does not treat an ordinarily published repository as a Git rewrite intent", () => {
    const project: CloudSyncEntity = {
      entityKind: "cloudProject",
      id: CloudProjectId.make("cloud-project"),
      name: "Pathway",
      description: "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      repositoryIdentity: identity,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 8,
    };

    expect(
      authoritativeEnvironmentRepositories(
        [
          project,
          binding({ id: "binding", localProjectId: "project", status: "active", updatedAt: 5 }),
        ],
        CURRENT,
      ),
    ).toEqual([]);
  });

  it.effect("updates the checkout's actual primary Git remote", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project");
      const run = vi.fn((input: ProcessRunner.ProcessRunInput) =>
        Effect.succeed({
          stdout: input.args.includes("-v")
            ? "origin https://github.com/old/pathway.git (fetch)\nupstream https://github.com/another/pathway.git (fetch)\n"
            : "",
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
      );
      const projects = {
        snapshot: Effect.succeed({
          projects: [
            {
              id: projectId,
              title: "Pathway",
              workspaceRoot: "/work/pathway",
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-08-20T00:00:00.000Z",
              updatedAt: "2026-08-20T00:00:00.000Z",
              deletedAt: null,
            },
          ],
          updatedAt: "2026-08-20T00:00:00.000Z",
        }),
      } as unknown as ProjectService.ProjectService["Service"];

      const reconciled = yield* reconcileAuthoritativeEnvironmentRepositories({
        repositories: [
          {
            bindingId: "binding",
            localProjectId: projectId,
            repositoryIdentity: identity,
            updatedAt: 8,
          },
        ],
        projects,
        processRunner: { run } as unknown as ProcessRunner.ProcessRunner["Service"],
      });

      expect(run.mock.calls.map(([input]) => input.args)).toEqual([
        ["-C", "/work/pathway", "remote", "-v"],
        [
          "-C",
          "/work/pathway",
          "remote",
          "set-url",
          "upstream",
          "https://github.com/SpiritDevs/pathway.git",
        ],
      ]);
      expect(reconciled).toEqual(["binding:github.com/spiritdevs/pathway:8"]);
    }),
  );

  it.effect("retries an unsettled Git remote without another cloud state change", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project");
      let setUrlAttempts = 0;
      const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
        const settingUrl = input.args.includes("set-url");
        if (settingUrl) setUrlAttempts += 1;
        return Effect.succeed({
          stdout: input.args.includes("-v")
            ? "origin https://github.com/old/pathway.git (fetch)\n"
            : "",
          stderr: "",
          code: settingUrl && setUrlAttempts === 1 ? 1 : 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      });
      const projects = {
        snapshot: Effect.succeed({
          projects: [
            {
              id: projectId,
              title: "Pathway",
              workspaceRoot: "/work/pathway",
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-08-20T00:00:00.000Z",
              updatedAt: "2026-08-20T00:00:00.000Z",
              deletedAt: null,
            },
          ],
          updatedAt: "2026-08-20T00:00:00.000Z",
        }),
      } as unknown as ProjectService.ProjectService["Service"];

      const reconciled = yield* reconcileAuthoritativeEnvironmentRepositoriesWithRetry({
        repositories: [
          {
            bindingId: "binding",
            localProjectId: projectId,
            repositoryIdentity: identity,
            updatedAt: 8,
          },
        ],
        projects,
        processRunner: { run } as unknown as ProcessRunner.ProcessRunner["Service"],
        attempts: 2,
        retryDelay: Duration.zero,
      });

      expect(setUrlAttempts).toBe(2);
      expect(reconciled).toEqual(["binding:github.com/spiritdevs/pathway:8"]);
    }),
  );
});
