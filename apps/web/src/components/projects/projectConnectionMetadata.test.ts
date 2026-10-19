import { companyEntityCodec } from "@spiritdevs/client-runtime/sync";
import { EnvironmentId } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import {
  buildProjectConnectionCatalog,
  deriveProjectConnectionMetadata,
  projectConnectionPlatformLabel,
} from "./projectConnectionMetadata";

function entity(
  kind: "cloudProject" | "environmentBinding" | "environmentRegistration",
  value: unknown,
) {
  const codec = companyEntityCodec(kind);
  if (codec === null) throw new Error(`Missing ${kind} codec`);
  return Option.getOrThrow(codec.decode(value));
}

describe("project connection metadata", () => {
  it("joins a project checkout to its binding and registered machine", () => {
    const environmentId = EnvironmentId.make("environment-build-mac");
    const values = [
      entity("cloudProject", {
        id: "cloud-pathway",
        name: "Pathway",
        description: "",
        teamIds: [],
        defaultWorkflowOwner: null,
        preferredBindingId: "binding-pathway-mac",
        archivedAt: null,
        createdAt: 1_000,
        updatedAt: 2_000,
      }),
      entity("environmentBinding", {
        id: "binding-pathway-mac",
        cloudProjectId: "cloud-pathway",
        environmentId,
        localProjectId: "project-pathway",
        localWorkspaceRoot: "/Users/corey/GitHub/pathway",
        status: "active",
        lastSeenAt: 3_000,
        createdAt: 1_000,
        updatedAt: 3_000,
      }),
      entity("environmentRegistration", {
        id: "registration-build-mac",
        environmentId,
        publicKeyThumbprint: "thumbprint",
        descriptor: {
          environmentId,
          label: "Build Mac",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.42.0",
          capabilities: { repositoryIdentity: true },
        },
        relayLinkState: "linked",
        managedEndpointAvailable: true,
        lastSeenAt: 4_000,
        serviceRoleIds: [],
        teamIds: [],
        state: "active",
        registeredByMembershipId: null,
        createdAt: 1_000,
        updatedAt: 4_000,
      }),
      entity("environmentBinding", {
        id: "binding-pathway-linux",
        cloudProjectId: "cloud-pathway",
        environmentId: EnvironmentId.make("environment-linux"),
        localProjectId: "project-pathway-linux",
        localWorkspaceRoot: "/srv/pathway",
        status: "stale",
        lastSeenAt: 2_500,
        createdAt: 1_000,
        updatedAt: 2_500,
      }),
      entity("environmentRegistration", {
        id: "registration-linux",
        environmentId: EnvironmentId.make("environment-linux"),
        publicKeyThumbprint: "linux-thumbprint",
        descriptor: {
          environmentId: EnvironmentId.make("environment-linux"),
          label: "Linux server",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.41.0",
          capabilities: { repositoryIdentity: true },
        },
        relayLinkState: "linked",
        managedEndpointAvailable: false,
        lastSeenAt: 2_500,
        serviceRoleIds: [],
        teamIds: [],
        state: "active",
        registeredByMembershipId: null,
        createdAt: 1_000,
        updatedAt: 2_500,
      }),
    ];
    const member = {
      environmentId,
      id: "project-pathway",
      workspaceRoot: "/stale/path",
      environmentLabel: "Old name",
    } as SidebarProjectGroupMember;

    const [connection, offlineConnection] = deriveProjectConnectionMetadata({
      members: [member],
      catalog: buildProjectConnectionCatalog(values),
    });

    expect(connection).toEqual({
      bindingId: "binding-pathway-mac",
      environmentId,
      localProjectId: "project-pathway",
      environmentLabel: "Build Mac",
      directory: "/Users/corey/GitHub/pathway",
      bindingStatus: "active",
      isPreferred: true,
      lastSeenAt: 3_000,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.42.0",
    });
    expect(offlineConnection).toMatchObject({
      environmentLabel: "Linux server",
      directory: "/srv/pathway",
      bindingStatus: "stale",
    });
    expect(projectConnectionPlatformLabel(connection!.platform)).toBe("macOS · arm64");
  });

  it("keeps local-only projects visible without Convex metadata", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const member = {
      environmentId,
      id: "project-local",
      workspaceRoot: "/work/local",
      environmentLabel: null,
    } as SidebarProjectGroupMember;

    expect(
      deriveProjectConnectionMetadata({
        members: [member],
        catalog: buildProjectConnectionCatalog([]),
      }),
    ).toEqual([
      expect.objectContaining({
        bindingId: null,
        environmentLabel: "This machine",
        directory: "/work/local",
        bindingStatus: null,
      }),
    ]);
  });
});
