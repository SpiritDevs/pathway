import {
  EnvironmentId,
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
  it("dedupes the same provider account across environments", () => {
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
