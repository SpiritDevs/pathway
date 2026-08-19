import { ProjectId, type EnvironmentId } from "@spiritdevs/contracts";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import { CompanyId } from "@spiritdevs/contracts/company";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_ENVIRONMENT_COMMAND_TTL_MS,
  ENVIRONMENT_COMMAND_LIST_LIMIT,
  ENVIRONMENT_CONTROL_FUNCTION_REFERENCES,
  makeEnvironmentControlClient,
  mapEnvironmentControlError,
  type EnvironmentControlConvexClient,
} from "./environmentControl";

const COMPANY_ID = CompanyId.make("company-1");
const ENVIRONMENT_ID = "environment-1" as EnvironmentId;

function fakeClient() {
  const calls: Array<{ readonly kind: string; readonly name: string; readonly args: unknown }> = [];
  let update:
    | {
        readonly callback: (value: unknown) => void;
        readonly onError?: (error: Error) => void;
      }
    | undefined;
  const unsubscribe = vi.fn();
  const client: EnvironmentControlConvexClient = {
    query: async (reference, args) => {
      calls.push({ kind: "query", name: getFunctionName(reference), args });
      return [];
    },
    mutation: async (reference, args) => {
      calls.push({ kind: "mutation", name: getFunctionName(reference), args });
      return null;
    },
    action: async (reference, args) => {
      calls.push({ kind: "action", name: getFunctionName(reference), args });
      return {
        id: "grant-1",
        token: "secret-once",
        environmentId: ENVIRONMENT_ID,
        membershipId: "membership-1",
        permission: "remoteAgents.control",
        issuedAt: 10,
        expiresAt: 20,
      };
    },
    onUpdate: (_reference, _args, callback, onError) => {
      update = { callback, ...(onError === undefined ? {} : { onError }) };
      return unsubscribe;
    },
    setAuth: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  return { calls, client, getUpdate: () => update, unsubscribe };
}

describe("environment control function references", () => {
  it("names every member-authorized backend function exactly", () => {
    expect(
      Object.fromEntries(
        Object.entries(ENVIRONMENT_CONTROL_FUNCTION_REFERENCES).map(([key, reference]) => [
          key,
          getFunctionName(reference as FunctionReference<"query">),
        ]),
      ),
    ).toEqual({
      issueCommand: "environmentCommands:issue",
      listCommands: "environmentCommands:list",
      cancelCommand: "environmentCommands:cancel",
      issueConnectGrant: "connectGrants:issue",
      deactivateEnvironment: "environments:deactivate",
      registerEnvironment: "environments:register",
      moveProjectToCompany: "projectMigration:moveProjectToCompany",
      createCompanyProject: "cloudProjects:createCompanyProject",
      ensureEnvironmentProject: "cloudProjects:ensureEnvironmentProject",
      setPreferredEnvironmentBinding: "cloudProjects:setPreferredEnvironmentBinding",
      releaseEnvironmentProject: "cloudProjects:releaseEnvironmentProject",
    });
  });

  it("mints an id and forwards the exact start-thread mutation shape", async () => {
    const fake = fakeClient();
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
    });

    const id = await control.issueCommand({
      companyId: COMPANY_ID,
      targetEnvironmentId: ENVIRONMENT_ID,
      cloudProjectId: null,
      kind: "startThread",
      args: { kind: "startThread", prompt: "Ship it", modelSelection: null },
    });

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(fake.calls).toEqual([
      {
        kind: "mutation",
        name: "environmentCommands:issue",
        args: {
          companyId: COMPANY_ID,
          id,
          targetEnvironmentId: ENVIRONMENT_ID,
          cloudProjectId: null,
          kind: "startThread",
          args: { kind: "startThread", prompt: "Ship it", modelSelection: null },
          ttlMs: DEFAULT_ENVIRONMENT_COMMAND_TTL_MS,
        },
      },
    ]);
  });

  it("subscribes at the backend maximum and maps subscription errors", () => {
    const fake = fakeClient();
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
    });
    const onValue = vi.fn();
    const onError = vi.fn();
    const unsubscribe = control.subscribeCommands(COMPANY_ID, onValue, onError);

    fake.getUpdate()?.callback([]);
    fake
      .getUpdate()
      ?.onError?.(
        new ConvexError({ code: "permission-denied", message: "Missing environments.read." }),
      );

    expect(onValue).toHaveBeenCalledWith([]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "You do not have permission to perform this action." }),
    );
    expect(unsubscribe).toBe(fake.unsubscribe);
    expect(ENVIRONMENT_COMMAND_LIST_LIMIT).toBe(500);
  });

  it("returns the one-time connect token without changing its action result", async () => {
    const fake = fakeClient();
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
    });
    const grant = await control.issueConnectGrant({
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      permission: "remoteAgents.control",
    });

    expect(grant.token).toBe("secret-once");
    expect(fake.calls[0]).toEqual({
      kind: "action",
      name: "connectGrants:issue",
      args: {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        permission: "remoteAgents.control",
      },
    });
  });

  it("registers the current environment with its durable proof identity and service role", async () => {
    const fake = fakeClient();
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
    });
    const descriptor = {
      environmentId: ENVIRONMENT_ID,
      label: "Corey's Mac",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true },
    };

    await control.registerEnvironment({
      companyId: COMPANY_ID,
      info: {
        descriptor,
        publicKeyThumbprint: "proof-thumbprint",
        relayLinkState: "linked",
        managedEndpointAvailable: true,
      },
      serviceRoleIds: ["manager-role"],
    });

    expect(fake.calls).toContainEqual({
      kind: "mutation",
      name: "environments:register",
      args: {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        descriptor,
        publicKeyThumbprint: "proof-thumbprint",
        relayLinkState: "linked",
        managedEndpointAvailable: true,
        serviceRoleIds: ["manager-role"],
        teamIds: [],
      },
    });
  });

  it("registers an environment-local project before assigning a cloud issue to it", async () => {
    const fake = fakeClient();
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
    });

    await control.ensureEnvironmentProject({
      companyId: COMPANY_ID,
      project: {
        id: ProjectId.make("project-a"),
        environmentId: ENVIRONMENT_ID,
        title: "Pathway",
        workspaceRoot: "/workspace/pathway",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      } satisfies EnvironmentProject,
    });

    expect(fake.calls).toContainEqual({
      kind: "mutation",
      name: "cloudProjects:ensureEnvironmentProject",
      args: {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        localProjectId: "project-a",
        localWorkspaceRoot: "/workspace/pathway",
        name: "Pathway",
      },
    });
  });

  it("releases a stale environment project binding without contacting that environment", async () => {
    const fake = fakeClient();
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
    });

    await control.releaseEnvironmentProject({
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      localProjectId: "project-a",
    });

    expect(fake.calls).toContainEqual({
      kind: "mutation",
      name: "cloudProjects:releaseEnvironmentProject",
      args: {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        localProjectId: "project-a",
      },
    });
  });

  it("sets the preferred environment binding for future project work", async () => {
    const fake = fakeClient();
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
    });

    await control.setPreferredEnvironmentBinding({
      companyId: COMPANY_ID,
      cloudProjectId: "project-company",
      bindingId: "binding-environment",
    });

    expect(fake.calls).toContainEqual({
      kind: "mutation",
      name: "cloudProjects:setPreferredEnvironmentBinding",
      args: {
        companyId: COMPANY_ID,
        cloudProjectId: "project-company",
        bindingId: "binding-environment",
      },
    });
  });
});

describe("mapEnvironmentControlError", () => {
  it("maps known refusals and preserves future backend messages", () => {
    expect(
      mapEnvironmentControlError(
        new ConvexError({ code: "invalid-command-state", message: "Raw state detail." }),
      ).message,
    ).toBe("That command can no longer be canceled.");
    expect(
      mapEnvironmentControlError(
        new ConvexError({ code: "future-code", message: "Useful future detail." }),
      ).message,
    ).toBe("Useful future detail.");
  });
});
