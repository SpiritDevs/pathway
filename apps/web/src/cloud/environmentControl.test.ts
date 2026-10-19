import { ProjectId, type EnvironmentId } from "@spiritdevs/contracts";
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
  type EnvironmentControlHttpClient,
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
      renameEnvironment: "relayPersistence:renameEnvironmentLink",
      moveProjectToCompany: "projectMigration:moveProjectToCompany",
      provisionPersonalWorkspace: "companies:provisionCurrentUser",
      createCompanyProject: "cloudProjects:createCompanyProject",
      ensureEnvironmentProject: "cloudProjects:ensureEnvironmentProject",
      setPreferredEnvironmentBinding: "cloudProjects:setPreferredEnvironmentBinding",
      releaseEnvironmentProject: "cloudProjects:releaseEnvironmentProject",
      deleteCompanyProject: "cloudProjects:deleteCompanyProject",
      mergeCompanyProjects: "cloudProjects:mergeCompanyProjects",
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

  it("renames any Pathway Connect environment through the account-owned Convex record", async () => {
    const fake = fakeClient();
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
    });

    await control.renameEnvironment({
      environmentId: ENVIRONMENT_ID,
      displayName: "Build laptop",
    });

    expect(fake.calls).toContainEqual({
      kind: "mutation",
      name: "relayPersistence:renameEnvironmentLink",
      args: { environmentId: ENVIRONMENT_ID, displayName: "Build laptop" },
    });
  });

  it("uses one authenticated HTTP request for a browser environment rename", async () => {
    const fake = fakeClient();
    const calls: Array<{ readonly name: string; readonly args: unknown }> = [];
    const httpClient: EnvironmentControlHttpClient = {
      setAuth: vi.fn(),
      mutation: async (reference, args) => {
        calls.push({ name: getFunctionName(reference), args });
        return null;
      },
    };
    const fetchToken = vi.fn(async () => "token");
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken,
      client: fake.client,
      httpClient,
    });

    await control.renameEnvironment({
      environmentId: ENVIRONMENT_ID,
      displayName: "Build laptop",
    });

    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: false });
    expect(httpClient.setAuth).toHaveBeenCalledWith("token");
    expect(calls).toEqual([
      {
        name: "relayPersistence:renameEnvironmentLink",
        args: { environmentId: ENVIRONMENT_ID, displayName: "Build laptop" },
      },
    ]);
    expect(fake.calls).toEqual([]);
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
      cloudProjectId: "cloud-project-a",
      matchRepository: false,
      // A full project shell still satisfies the narrowed parameter; the mutation reads four
      // fields and the rest are along for the ride.
      project: {
        id: ProjectId.make("project-a"),
        environmentId: ENVIRONMENT_ID,
        title: "Pathway",
        workspaceRoot: "/workspace/pathway",
      },
    });

    expect(fake.calls).toContainEqual({
      kind: "mutation",
      name: "cloudProjects:ensureEnvironmentProject",
      args: {
        companyId: COMPANY_ID,
        cloudProjectId: "cloud-project-a",
        matchRepository: false,
        environmentId: ENVIRONMENT_ID,
        localProjectId: "project-a",
        localWorkspaceRoot: "/workspace/pathway",
        repositoryIdentity: null,
        name: "Pathway",
      },
    });
  });

  it("assigns an environment-local project with one authenticated HTTP request", async () => {
    const fake = fakeClient();
    const calls: Array<{ readonly name: string; readonly args: unknown }> = [];
    const httpClient: EnvironmentControlHttpClient = {
      setAuth: vi.fn(),
      mutation: async (reference, args) => {
        calls.push({ name: getFunctionName(reference), args });
        return null;
      },
    };
    const fetchToken = vi.fn(async () => "token");
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken,
      client: fake.client,
      httpClient,
    });

    await control.ensureEnvironmentProject({
      companyId: COMPANY_ID,
      cloudProjectId: "cloud-project-a",
      project: {
        id: ProjectId.make("project-a"),
        environmentId: ENVIRONMENT_ID,
        title: "Pathway",
        workspaceRoot: "/workspace/pathway",
      },
    });

    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: false });
    expect(httpClient.setAuth).toHaveBeenCalledWith("token");
    expect(calls).toEqual([
      {
        name: "cloudProjects:ensureEnvironmentProject",
        args: {
          companyId: COMPANY_ID,
          cloudProjectId: "cloud-project-a",
          environmentId: ENVIRONMENT_ID,
          localProjectId: "project-a",
          localWorkspaceRoot: "/workspace/pathway",
          repositoryIdentity: null,
          name: "Pathway",
        },
      },
    ]);
    expect(fake.calls).toEqual([]);
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

  it("deletes a company project with one authenticated HTTP request", async () => {
    const fake = fakeClient();
    const calls: Array<{ readonly name: string; readonly args: unknown }> = [];
    const httpClient: EnvironmentControlHttpClient = {
      setAuth: vi.fn(),
      mutation: async (reference, args) => {
        calls.push({ name: getFunctionName(reference), args });
        return { deleted: true };
      },
    };
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
      httpClient,
    });

    // The caller decides between "removed" and "this workspace owned nothing by that id" from
    // this value, so the authenticated HTTP path has to hand it back rather than discard it.
    expect(
      await control.deleteCompanyProject({
        companyId: COMPANY_ID,
        cloudProjectId: "project-company",
      }),
    ).toEqual({ deleted: true });

    expect(calls).toEqual([
      {
        name: "cloudProjects:deleteCompanyProject",
        args: { companyId: COMPANY_ID, cloudProjectId: "project-company" },
      },
    ]);
    expect(fake.calls).toEqual([]);
  });

  it("merges projects with the selected repository", async () => {
    const fake = fakeClient();
    const calls: Array<{ readonly name: string; readonly args: unknown }> = [];
    const httpClient: EnvironmentControlHttpClient = {
      setAuth: vi.fn(),
      mutation: async (reference, args) => {
        calls.push({ name: getFunctionName(reference), args });
        return { movedBindings: 1, movedThreads: 2, movedIssues: 3 };
      },
    };
    const control = makeEnvironmentControlClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: vi.fn(async () => "token"),
      client: fake.client,
      httpClient,
    });
    const repositoryIdentity = {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/SpiritDevs/pathway.git",
      },
    };

    await expect(
      control.mergeCompanyProjects({
        companyId: COMPANY_ID,
        sourceCloudProjectId: "duplicate",
        targetCloudProjectId: "pathway",
        repositoryIdentity,
      }),
    ).resolves.toEqual({ movedBindings: 1, movedThreads: 2, movedIssues: 3 });
    expect(calls).toEqual([
      {
        name: "cloudProjects:mergeCompanyProjects",
        args: {
          companyId: COMPANY_ID,
          sourceCloudProjectId: "duplicate",
          targetCloudProjectId: "pathway",
          repositoryIdentity,
        },
      },
    ]);
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
