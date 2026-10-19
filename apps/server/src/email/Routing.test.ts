import { EmailMailSlug, ProjectId, type EmailProjectSettings } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";

import { reconcileEmailProjectSettings, routeEmail } from "./Routing.ts";

const alphaProjectId = ProjectId.make("project-alpha");
const betaProjectId = ProjectId.make("project-beta");

const projectSettings = (
  projectId: typeof alphaProjectId,
  mailSlug: string,
  capturePassword: string | null,
): EmailProjectSettings => ({
  projectId,
  mailSlug: EmailMailSlug.make(mailSlug),
  capturePassword,
  retention: { maxMessages: null, maxAgeDays: null },
  toastMuted: false,
  twoFactorCodeRegex: null,
});

const route = (
  input: Partial<Pick<Parameters<typeof routeEmail>[0], "authUsername" | "authPassword">>,
) =>
  routeEmail({
    authUsername: null,
    authPassword: null,
    recipients: ["test-user@example.com"],
    projects: [
      projectSettings(alphaProjectId, "alpha", null),
      projectSettings(betaProjectId, "beta", "fixed-account-password"),
    ],
    ...input,
  });

describe("routeEmail password attribution", () => {
  it("routes a fixed SMTP account by its capture password", () => {
    expect(
      route({ authUsername: "fixed-account", authPassword: "fixed-account-password" }),
    ).toEqual({
      projectId: betaProjectId,
      mailSlug: EmailMailSlug.make("beta"),
      matchedBy: "auth-password",
      matchedValue: "fixed-account-password",
    });
  });

  it("checks the password only after the AUTH username misses", () => {
    expect(route({ authUsername: "alpha", authPassword: "fixed-account-password" })).toMatchObject({
      projectId: alphaProjectId,
      matchedBy: "auth-username",
    });
  });

  it("never treats a null capture password as a match", () => {
    expect(route({ authUsername: "fixed-account", authPassword: "alpha" })).toMatchObject({
      projectId: null,
      matchedBy: "unassigned",
    });
  });

  it("uses the first project when capture passwords are shared", () => {
    const attribution = routeEmail({
      authUsername: "fixed-account",
      authPassword: "shared-password",
      recipients: ["test-user@example.com"],
      projects: [
        projectSettings(alphaProjectId, "alpha", "shared-password"),
        projectSettings(betaProjectId, "beta", "shared-password"),
      ],
    });

    expect(attribution).toMatchObject({ projectId: alphaProjectId, matchedBy: "auth-password" });
  });
});

describe("reconcileEmailProjectSettings", () => {
  it("releases a deleted project's slug while preserving the live project's overrides", () => {
    const current = projectSettings(betaProjectId, "quotecloud-v2-2", "fixed-account-password");
    const reconciled = reconcileEmailProjectSettings({
      projects: [{ projectId: betaProjectId, title: "Beta", workspaceRoot: "/work/beta" }],
      configured: [projectSettings(alphaProjectId, "quotecloud-v2", null), current],
    });

    expect(reconciled).toEqual([current]);
  });
});
