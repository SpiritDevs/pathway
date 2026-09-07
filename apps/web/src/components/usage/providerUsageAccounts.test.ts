import {
  EnvironmentId,
  IsoDateTime,
  type ServerProviderUsageSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveConnectedProviderUsageAccounts } from "./providerUsageAccounts";

const studioId = EnvironmentId.make("studio");
const laptopId = EnvironmentId.make("laptop");

function provider(input: {
  readonly driver: "codex" | "claudeAgent";
  readonly instanceId: string;
  readonly displayName: string;
  readonly email?: string;
}): ServerProvider {
  return {
    driver: ProviderDriverKind.make(input.driver),
    instanceId: ProviderInstanceId.make(input.instanceId),
    displayName: input.displayName,
    enabled: true,
    installed: true,
    auth: {
      status: input.email ? "authenticated" : "unknown",
      ...(input.email ? { email: input.email } : {}),
    },
  } as ServerProvider;
}

describe("connected provider usage accounts", () => {
  it("preserves accounts with the same email across environments", () => {
    const studioClaude = provider({
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      displayName: "Claude",
      email: "corey@example.com",
    });
    const laptopClaude = provider({
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      displayName: "Claude",
      email: " Corey@Example.com ",
    });

    expect(
      deriveConnectedProviderUsageAccounts([
        { environmentId: studioId, providers: [studioClaude] },
        { environmentId: laptopId, providers: [laptopClaude] },
      ]),
    ).toEqual([
      expect.objectContaining({
        environmentId: studioId,
        provider: studioClaude,
        displayName: "Claude",
      }),
      expect.objectContaining({ environmentId: laptopId, provider: laptopClaude }),
    ]);
  });

  it("keeps separate accounts and separate provider subscriptions", () => {
    const personalCodex = provider({
      driver: "codex",
      instanceId: "codex",
      displayName: "Codex",
      email: "personal@example.com",
    });
    const workCodex = provider({
      driver: "codex",
      instanceId: "work",
      displayName: "Work",
      email: "work@example.com",
    });
    const claude = provider({
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      displayName: "Claude",
      email: "personal@example.com",
    });

    expect(
      deriveConnectedProviderUsageAccounts([
        { environmentId: studioId, providers: [personalCodex, workCodex, claude] },
      ]).map((account) => account.displayName),
    ).toEqual(["Codex", "Work", "Claude"]);
  });

  it("does not merge providers whose account identity is unavailable", () => {
    const studioCodex = provider({
      driver: "codex",
      instanceId: "codex",
      displayName: "Codex",
    });
    const laptopCodex = provider({
      driver: "codex",
      instanceId: "codex",
      displayName: "Codex",
    });

    expect(
      deriveConnectedProviderUsageAccounts([
        { environmentId: studioId, providers: [studioCodex] },
        { environmentId: laptopId, providers: [laptopCodex] },
      ]),
    ).toHaveLength(2);
  });
});

function usage(
  instanceId: string,
  accountKey: string,
  updatedAt = "2026-09-08T00:00:00Z",
  stale = false,
): ServerProviderUsageSnapshot {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    provider: "codex",
    accountKey,
    updatedAt: IsoDateTime.make(updatedAt),
    status: "ok",
    source: "test",
    limits: [],
    usageLines: [],
    stale,
  };
}

describe("grouping Codex subscriptions", () => {
  const personal = provider({
    driver: "codex",
    instanceId: "codex",
    displayName: "Codex",
    email: "same@example.com",
  });
  const work = provider({
    driver: "codex",
    instanceId: "work",
    displayName: "Work",
    email: "same@example.com",
  });
  const environments = [studioId, laptopId, EnvironmentId.make("studio-2")].map(
    (environmentId, index) => ({
      environmentId,
      providers: [personal, work],
      usage: [usage("codex", "personal", `2026-09-08T0${index}:00:00Z`), usage("work", "work")],
    }),
  );

  it("shows two subscriptions across three environments, even with the same email", () => {
    const accounts = deriveConnectedProviderUsageAccounts(environments);
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.displayName)).toEqual(["Codex", "Work"]);
    expect(accounts[0]?.environmentId).toBe(environments[2]?.environmentId);
  });

  it("prefers live usage over a newer stale reading", () => {
    const accounts = deriveConnectedProviderUsageAccounts([
      environments[0]!,
      { ...environments[1]!, usage: [usage("codex", "personal", "2026-09-08T05:00:00Z", true)] },
    ]);
    expect(accounts.find((account) => account.displayName === "Codex")?.environmentId).toBe(
      studioId,
    );
  });

  it("uses a remaining environment after a disconnect and separates an account switch", () => {
    expect(deriveConnectedProviderUsageAccounts(environments.slice(1))).toHaveLength(2);
    expect(
      deriveConnectedProviderUsageAccounts([
        environments[0]!,
        { ...environments[1]!, usage: [usage("codex", "new-login"), usage("work", "work")] },
      ]),
    ).toHaveLength(3);
  });
});
