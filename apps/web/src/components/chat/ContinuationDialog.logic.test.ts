import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@spiritdevs/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { resolveInitialContinuationSelection } from "./ContinuationDialog.logic";

const entry = (instanceId: string, driver: string, status: "ready" | "error" = "ready") =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make(driver),
    displayName: instanceId,
    enabled: true,
    installed: true,
    status,
    isDefault: true,
    isAvailable: true,
    snapshot: {},
    models: [],
  }) as unknown as ProviderInstanceEntry;

const source = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" };

describe("resolveInitialContinuationSelection", () => {
  it("keeps the current model for a continuation", () => {
    expect(
      resolveInitialContinuationSelection({
        kind: "continue",
        source,
        instanceEntries: [],
        modelOptionsByInstance: new Map(),
      }),
    ).toEqual(source);
  });

  it("prefers a ready different provider for handoff", () => {
    expect(
      resolveInitialContinuationSelection({
        kind: "handoff",
        source,
        instanceEntries: [
          entry("codex", "codex"),
          entry("codex-team", "codex"),
          entry("claude", "claudeAgent"),
        ],
        modelOptionsByInstance: new Map([
          [ProviderInstanceId.make("codex-team"), [{ slug: "gpt-5.4", name: "GPT" }]],
          [ProviderInstanceId.make("claude"), [{ slug: "opus", name: "Opus" }]],
        ]),
      }),
    ).toEqual({ instanceId: ProviderInstanceId.make("claude"), model: "opus" });
  });

  it("returns null when no alternative ready instance has a model", () => {
    expect(
      resolveInitialContinuationSelection({
        kind: "handoff",
        source,
        instanceEntries: [entry("codex", "codex"), entry("claude", "claudeAgent", "error")],
        modelOptionsByInstance: new Map(),
      }),
    ).toBeNull();
  });
});
