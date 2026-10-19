import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@spiritdevs/contracts";
import { createModelSelection } from "@spiritdevs/shared/model";

import { getCodexServiceTierOptionValue, resolveCodexTurnOptions } from "./codexModelOptions.ts";

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});

it("uses discovered defaults for stale effort and legacy fast settings", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
    { id: "reasoningEffort", value: "minimal" },
    { id: "fastMode", value: true },
  ]);
  assert.deepEqual(
    resolveCodexTurnOptions(selection, {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "low",
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    }),
    { effort: "low", serviceTier: undefined },
  );
  assert.deepEqual(resolveCodexTurnOptions(selection), { effort: "minimal", serviceTier: "fast" });
});

it("retains supported choices and rejects a stale advertised currentValue", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "flex" },
  ]);
  assert.deepEqual(
    resolveCodexTurnOptions(selection, {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High" }],
        },
        {
          id: "serviceTier",
          label: "Tier",
          type: "select",
          currentValue: "fast",
          options: [{ id: "standard", label: "Standard", isDefault: true }],
        },
      ],
    }),
    { effort: "high", serviceTier: "standard" },
  );
  assert.deepEqual(resolveCodexTurnOptions(selection, {}), {
    effort: undefined,
    serviceTier: undefined,
  });
});
