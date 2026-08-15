import { describe, expect, it } from "vite-plus/test";

import { COMPANY_ADMINISTRATION_PERMISSIONS, isPermissionKey } from "./permissions.ts";
import {
  isSmokeCompanyDomainId,
  isSmokeEnvironmentId,
  isSweepableSmokeOrphan,
  isUsableSmokeKey,
  SMOKE_COMPANY_DOMAIN_ID,
  SMOKE_ENVIRONMENT_ID_PREFIX,
  SMOKE_ORPHAN_MIN_AGE_MS,
  SMOKE_ROLE_DOMAIN_ID,
  smokeDescriptor,
  smokeRegistrationDomainId,
  smokeServiceRolePermissions,
} from "./smokeSeed.ts";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

describe("smokeServiceRolePermissions", () => {
  it("grants exactly the read gates the sync feed filters on plus the workflow write switch", () => {
    expect([...smokeServiceRolePermissions()].sort()).toEqual(
      [
        "company.read",
        "members.read",
        "teams.read",
        "roles.read",
        "projects.read",
        "environments.read",
        "issues.read",
        "audit.read",
        "workflow.manage",
      ].sort(),
    );
  });

  it("grants no remote-agent switch, because no smoke step exercises one", () => {
    // The harness only calls `environmentCommands.list` (gated on `environments.read`) and
    // `claim` (gated on the actor kind); `remoteAgents.*` would be an unearned grant.
    for (const permission of smokeServiceRolePermissions()) {
      expect(permission.startsWith("remoteAgents.")).toBe(false);
    }
  });

  it("only names known permission switches", () => {
    for (const permission of smokeServiceRolePermissions()) {
      expect(isPermissionKey(permission)).toBe(true);
    }
  });

  it("never grants a company-administration write switch", () => {
    // The read gates and `workflow.manage` are deliberately outside the administration set;
    // nothing the smoke role carries may manage members, roles, environments, or exports.
    for (const permission of smokeServiceRolePermissions()) {
      expect(COMPANY_ADMINISTRATION_PERMISSIONS.has(permission)).toBe(false);
    }
  });
});

describe("smokeRegistrationDomainId", () => {
  it("is deterministic and UUIDv7-shaped", () => {
    const id = smokeRegistrationDomainId("environment-1");
    expect(id).toBe(smokeRegistrationDomainId("environment-1"));
    expect(id).toMatch(UUID_SHAPE);
  });

  it("differs per environment and never collides with the reserved company or role ids", () => {
    const a = smokeRegistrationDomainId("environment-a");
    const b = smokeRegistrationDomainId("environment-b");
    expect(a).not.toBe(b);
    for (const id of [a, b]) {
      expect(id).not.toBe(SMOKE_COMPANY_DOMAIN_ID);
      expect(id).not.toBe(SMOKE_ROLE_DOMAIN_ID);
    }
  });
});

describe("smokeDescriptor", () => {
  it("is the minimal valid ExecutionEnvironmentDescriptor for the environment", () => {
    expect(smokeDescriptor("environment-1")).toEqual({
      environmentId: "environment-1",
      label: "Smoke Test — relay e2e environment",
      platform: { os: "unknown", arch: "other" },
      serverVersion: "0.0.0-smoke",
      capabilities: { repositoryIdentity: false },
    });
  });
});

describe("isSmokeCompanyDomainId", () => {
  it("accepts only the reserved smoke company id", () => {
    expect(isSmokeCompanyDomainId(SMOKE_COMPANY_DOMAIN_ID)).toBe(true);
    expect(isSmokeCompanyDomainId(SMOKE_ROLE_DOMAIN_ID)).toBe(false);
    expect(isSmokeCompanyDomainId("0198f7f0-0000-7000-8000-000000000000")).toBe(false);
    expect(isSmokeCompanyDomainId("")).toBe(false);
  });

  it("the reserved ids are themselves UUIDv7-shaped", () => {
    expect(SMOKE_COMPANY_DOMAIN_ID).toMatch(UUID_SHAPE);
    expect(SMOKE_ROLE_DOMAIN_ID).toMatch(UUID_SHAPE);
  });
});

describe("isSmokeEnvironmentId", () => {
  it("accepts exactly the ids the harness mints under the synthetic prefix", () => {
    expect(isSmokeEnvironmentId(`${SMOKE_ENVIRONMENT_ID_PREFIX}0198f7f0`)).toBe(true);
    expect(isSmokeEnvironmentId(SMOKE_ENVIRONMENT_ID_PREFIX)).toBe(true);
    expect(isSmokeEnvironmentId("environment-1")).toBe(false);
    expect(isSmokeEnvironmentId("smoke-env-1")).toBe(false);
    // The prefix must lead: a real id merely containing it stays untouchable.
    expect(isSmokeEnvironmentId(`prod-${SMOKE_ENVIRONMENT_ID_PREFIX}x`)).toBe(false);
    expect(isSmokeEnvironmentId("")).toBe(false);
  });
});

describe("isSweepableSmokeOrphan", () => {
  const now = 1_800_000_000_000;
  const orphan = (updatedAt: number, environmentId = `${SMOKE_ENVIRONMENT_ID_PREFIX}0198f7f0`) => ({
    environmentId,
    updatedAt,
    now,
  });

  it("sweeps a synthetic registration only once it is older than the orphan threshold", () => {
    expect(isSweepableSmokeOrphan(orphan(now - SMOKE_ORPHAN_MIN_AGE_MS))).toBe(true);
    expect(isSweepableSmokeOrphan(orphan(now - SMOKE_ORPHAN_MIN_AGE_MS - 1))).toBe(true);
    // A registration touched moments ago may belong to a smoke run still in flight: sweeping it
    // would delete the shared company out from under that run.
    expect(isSweepableSmokeOrphan(orphan(now))).toBe(false);
    expect(isSweepableSmokeOrphan(orphan(now - SMOKE_ORPHAN_MIN_AGE_MS + 1))).toBe(false);
    // A clock that ran backwards leaves a future timestamp; that is not aged out either.
    expect(isSweepableSmokeOrphan(orphan(now + SMOKE_ORPHAN_MIN_AGE_MS))).toBe(false);
  });

  it("never sweeps a registration outside the synthetic prefix, however old", () => {
    expect(isSweepableSmokeOrphan(orphan(0, "environment-1"))).toBe(false);
    expect(isSweepableSmokeOrphan(orphan(0, `prod-${SMOKE_ENVIRONMENT_ID_PREFIX}x`))).toBe(false);
  });
});

describe("isUsableSmokeKey", () => {
  it("accepts exact-match keys and refuses anything that would be silently normalized", () => {
    expect(isUsableSmokeKey("environment-1")).toBe(true);
    expect(isUsableSmokeKey("NkLvbW…thumb")).toBe(true);
    expect(isUsableSmokeKey("")).toBe(false);
    expect(isUsableSmokeKey("  ")).toBe(false);
    expect(isUsableSmokeKey(" environment-1")).toBe(false);
    expect(isUsableSmokeKey("environment-1\n")).toBe(false);
  });
});
