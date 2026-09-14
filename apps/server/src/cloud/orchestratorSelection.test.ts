import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@spiritdevs/contracts";
import {
  OrchestratorAction,
  delegationSelectionProblem,
} from "@spiritdevs/contracts/aiOrchestrator";
import { orchestratorDelegationCatalog, resolveDelegatedModel } from "./orchestratorSelection.ts";

const selection = (model: string) => ({ instanceId: ProviderInstanceId.make("custom"), model });
const decodeAction = Schema.decodeUnknownSync(OrchestratorAction);
const snapshot = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "custom",
  driver: "codex",
  displayName: "Work account",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", email: "private@example.test" },
  version: null,
  checkedAt: "2026-09-14T00:00:00.000Z",
  models: [
    {
      slug: "discovered-model",
      name: "Discovered model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
});
const catalog = orchestratorDelegationCatalog([snapshot], selection("discovered-model"));

describe("delegation selection discovery and defaults", () => {
  it("preserves exact explicit selections before project and environment defaults", () => {
    const explicit = { ...selection("requested"), options: [{ id: "effort", value: "low" }] };
    expect(resolveDelegatedModel(explicit, selection("project"), selection("environment"))).toBe(
      explicit,
    );
    expect(resolveDelegatedModel(null, selection("project"), selection("environment"))).toEqual(
      selection("project"),
    );
    expect(resolveDelegatedModel(null, null, selection("environment"))).toEqual(
      selection("environment"),
    );
  });
  it("publishes actual option IDs without account details, invented capabilities or prices", () => {
    expect(catalog.providers[0]?.models[0]?.options[0]?.id).toBe("effort");
    expect(catalog.providers[0]).not.toHaveProperty("auth");
    expect(catalog.defaultSelection).toEqual(selection("discovered-model"));
  });
  it("rejects unsupported models and reasoning without choosing a fallback", () => {
    expect(delegationSelectionProblem(selection("invented"), catalog)).toContain("not advertised");
    for (const options of [
      [{ id: "effort", value: "max" }],
      [{ id: "invented", value: "high" }],
      [
        { id: "effort", value: "low" },
        { id: "effort", value: "high" },
      ],
    ])
      expect(
        delegationSelectionProblem({ ...selection("discovered-model"), options }, catalog),
      ).not.toBeNull();
    expect(
      delegationSelectionProblem(
        { ...selection("discovered-model"), options: [{ id: "effort", value: "low" }] },
        catalog,
      ),
    ).toBeNull();
    expect(delegationSelectionProblem(selection("discovered-model"), catalog)).toBeNull();
  });
  it.each([
    { enabled: false },
    { installed: false },
    { availability: "unavailable" as const },
    { status: "error" as const },
    { auth: { status: "unauthenticated" as const } },
  ])("refuses unavailable provider state %j", (patch) => {
    const unavailable = orchestratorDelegationCatalog(
      [{ ...snapshot, ...patch }],
      selection("discovered-model"),
    );
    expect(delegationSelectionProblem(selection("discovered-model"), unavailable)).toContain(
      "unavailable",
    );
  });
  it("bounds catalogs and marks omitted models explicitly", () => {
    const large = {
      ...snapshot,
      models: Array.from({ length: 250 }, (_, i) => ({
        ...snapshot.models[0]!,
        slug: `model-${i}`,
      })),
    };
    const bounded = orchestratorDelegationCatalog([large], selection("model-0"));
    expect(bounded.truncated).toBe(true);
    expect(bounded.providers[0]?.models).toHaveLength(100);
    expect(delegationSelectionProblem(selection("model-249"), bounded)).not.toBeNull();
  });
});

it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "custom-driver"])(
  "discovers worker models for %s independently of the coordinator driver restriction",
  (driver) => {
    const provider = { ...snapshot, driver: ProviderDriverKind.make(driver) };
    const catalog = orchestratorDelegationCatalog([provider], selection("discovered-model"));
    expect(delegationSelectionProblem(selection("discovered-model"), catalog)).toBeNull();
  },
);

it("rejects malformed action options instead of silently dropping an explicit override", () => {
  const action = {
    kind: "delegate",
    title: "Task",
    companyId: "company",
    projectId: null,
    environmentId: "environment",
    prompt: "Check the task",
    selection: {
      instanceId: "custom",
      model: "discovered-model",
      options: { effort: 123 },
    },
  };
  expect(() => decodeAction(action)).toThrow();
});
