import type { ModelCapabilities, ProviderOptionSelection } from "@spiritdevs/contracts";
import { getProviderOptionDescriptors } from "@spiritdevs/shared/model";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerComputerControlEffortHint } from "./ComposerComputerControlEffortHint";
import {
  buildComputerControlHintOptions,
  COMPUTER_CONTROL_HINT_EFFORT,
  getComputerControlEffortHintTraits,
  shouldShowComputerControlEffortHint,
  type ComputerControlEffortHintInput,
} from "./composerComputerControlHint";

const EFFORT_LADDER = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High", isDefault: true },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
];

// Claude Opus 5 shape: effort defaults to High, plus an unrelated fast mode.
const OPUS_5: ModelCapabilities = {
  optionDescriptors: [
    { id: "effort", label: "Effort", type: "select", options: EFFORT_LADDER },
    { id: "fastMode", label: "Fast mode", type: "boolean" },
  ],
};
// Opus 4.8 shape: the ladder also offers the prompt-injected Ultrathink mode.
const OPUS_4_8: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Effort",
      type: "select",
      options: [...EFFORT_LADDER, { id: "ultrathink", label: "Ultrathink" }],
      promptInjectedValues: ["ultrathink"],
    },
  ],
};
const NO_LADDER: ModelCapabilities = { optionDescriptors: [] };

function descriptorsFor(
  caps: ModelCapabilities,
  selections?: ReadonlyArray<ProviderOptionSelection>,
) {
  return getProviderOptionDescriptors({ caps, selections });
}

function traitsFor(
  caps: ModelCapabilities,
  selections?: ReadonlyArray<ProviderOptionSelection>,
  prompt = "",
) {
  return getComputerControlEffortHintTraits({
    descriptors: descriptorsFor(caps, selections),
    prompt,
  });
}

function hintInput(
  overrides: Partial<ComputerControlEffortHintInput> = {},
): ComputerControlEffortHintInput {
  return {
    enableComputerControl: true,
    computerControlAvailable: true,
    dismissed: false,
    provider: "claudeAgent",
    traits: traitsFor(OPUS_5),
    ...overrides,
  };
}

describe("shouldShowComputerControlEffortHint", () => {
  it("shows for a claudeAgent chat driving the desktop at the default effort", () => {
    expect(shouldShowComputerControlEffortHint(hintInput())).toBe(true);
  });

  it("resolves the default effort as High, so Medium is a real change", () => {
    const traits = traitsFor(OPUS_5);
    expect(traits.defaultEffort).toBe("high");
    expect(traits.effort).toBe("high");
    expect(traits.effortLevels.map((level) => level.id)).toContain(COMPUTER_CONTROL_HINT_EFFORT);
  });

  it("stays hidden while computer control is off", () => {
    expect(shouldShowComputerControlEffortHint(hintInput({ enableComputerControl: false }))).toBe(
      false,
    );
  });

  it("stays hidden while the desktop backend is unavailable", () => {
    expect(
      shouldShowComputerControlEffortHint(hintInput({ computerControlAvailable: false })),
    ).toBe(false);
  });

  it("stays hidden once dismissed", () => {
    expect(shouldShowComputerControlEffortHint(hintInput({ dismissed: true }))).toBe(false);
  });

  it("stays hidden for other providers", () => {
    expect(shouldShowComputerControlEffortHint(hintInput({ provider: "codex" }))).toBe(false);
  });

  it("stays hidden once the user has picked another effort", () => {
    for (const effort of ["low", "medium", "xhigh", "max"]) {
      const traits = traitsFor(OPUS_5, [{ id: "effort", value: effort }]);
      expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
    }
  });

  it("stays hidden while an Ultrathink prompt owns the effort", () => {
    const traits = traitsFor(OPUS_4_8, undefined, "Ultrathink: rewrite the loop");
    expect(traits.ultrathinkPromptControlled).toBe(true);
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
  });

  it("stays hidden for a model with no effort ladder", () => {
    const traits = traitsFor(NO_LADDER);
    expect(traits.effortLevels).toHaveLength(0);
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
  });

  it("stays hidden when the model already defaults to Medium", () => {
    const traits = traitsFor({
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
          ],
        },
      ],
    });
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
  });

  it("ignores unrelated trait changes such as fast mode", () => {
    const traits = traitsFor(OPUS_5, [{ id: "fastMode", value: true }]);
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(true);
  });
});

describe("computer-control effort hint actions", () => {
  it("apply writes Medium and hides the hint", () => {
    const nextOptions = buildComputerControlHintOptions(descriptorsFor(OPUS_5));
    expect(nextOptions).toContainEqual({ id: "effort", value: "medium" });

    const traits = traitsFor(OPUS_5, nextOptions);
    expect(traits.effort).toBe("medium");
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
  });

  it("apply preserves other provider options", () => {
    const nextOptions = buildComputerControlHintOptions(
      descriptorsFor(OPUS_5, [{ id: "fastMode", value: true }]),
    );
    expect(nextOptions).toEqual([
      { id: "effort", value: "medium" },
      { id: "fastMode", value: true },
    ]);
  });

  it("dismiss hides the hint without touching the selected effort", () => {
    const traits = traitsFor(OPUS_5);
    expect(shouldShowComputerControlEffortHint(hintInput({ traits, dismissed: true }))).toBe(false);
    expect(traits.effort).toBe("high");
  });
});

describe("ComposerComputerControlEffortHint", () => {
  it("renders the tip, the Medium action and a dismiss control", () => {
    const html = renderToStaticMarkup(
      <ComposerComputerControlEffortHint onApply={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain('data-testid="composer-computer-control-effort-hint"');
    expect(html).toContain("Desktop actions are faster at Medium effort");
    expect(html).toContain("Use Medium");
    expect(html).toContain('aria-label="Dismiss tip"');
  });
});
