import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, type Project } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { getFunctionName, type FunctionReference } from "convex/server";
import * as Effect from "effect/Effect";

import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import type { ConvexClientLike } from "./convexSyncTransport.ts";
import { makeCloudProjectPublisher } from "./cloudProjectPublisher.ts";

const COMPANY_ID = CompanyId.make("company-project-publisher");
const ENVIRONMENT_ID = EnvironmentId.make("environment-project-publisher");
const PROJECT_ID = ProjectId.make("project-project-publisher");

const PROJECT: Project = {
  id: PROJECT_ID,
  title: "Pathway",
  workspaceRoot: "/work/pathway",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  deletedAt: null,
};

describe("cloud project publisher", () => {
  it.effect("publishes and releases the machine-specific project binding", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly name: string;
        readonly args: unknown;
        readonly token: string;
      }> = [];
      let token = "service-token";
      const client: ConvexClientLike = {
        setAuth: (next) => {
          token = next;
        },
        query: (() => Promise.reject(new Error("unexpected query"))) as ConvexClientLike["query"],
        mutation: ((reference: FunctionReference<"mutation">, args: unknown) => {
          calls.push({ name: getFunctionName(reference), args, token });
          return Promise.resolve(
            getFunctionName(reference) === "cloudProjects:ensureEnvironmentProject"
              ? PROJECT_ID
              : null,
          );
        }) as ConvexClientLike["mutation"],
      };
      const tokens: ConvexServiceTokenProvider = {
        token: Effect.succeed("service-token"),
        invalidate: () => Effect.void,
      };
      const publisher = yield* makeCloudProjectPublisher({
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        convexUrl: "https://example.convex.cloud",
        tokens,
        client,
      });

      yield* publisher.publish(PROJECT);
      yield* publisher.release(PROJECT_ID);

      assert.deepEqual(calls, [
        {
          name: "cloudProjects:ensureEnvironmentProject",
          token: "service-token",
          args: {
            companyId: COMPANY_ID,
            environmentId: ENVIRONMENT_ID,
            localProjectId: PROJECT_ID,
            localWorkspaceRoot: "/work/pathway",
            repositoryIdentity: null,
            name: "Pathway",
            allowCreate: false,
          },
        },
        {
          name: "cloudProjects:releaseEnvironmentProject",
          token: "service-token",
          args: {
            companyId: COMPANY_ID,
            environmentId: ENVIRONMENT_ID,
            localProjectId: PROJECT_ID,
          },
        },
      ]);
    }),
  );
});
