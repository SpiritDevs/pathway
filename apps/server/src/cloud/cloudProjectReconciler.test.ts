import type { CloudSyncEntity } from "@spiritdevs/client-runtime/sync";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { CloudProjectId, EnvironmentBindingId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import {
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

  it("force-deletes a live local project and settles its durable intent", async () => {
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

    const reconciled = await Effect.runPromise(
      reconcileRevokedEnvironmentProjects({
        companyId: CompanyId.make("company"),
        environmentId: CURRENT,
        revoked: [{ bindingId: "binding", localProjectId: projectId, updatedAt: 7 }],
        projects,
        orchestration,
      }),
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "project.delete",
      projectId,
      force: true,
    });
    expect(reconciled).toEqual(["binding:7"]);
  });
});
