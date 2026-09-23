import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@spiritdevs/contracts";

import { BUNDLED_MODEL_MANIFEST } from "./provider/ModelManifest.ts";
import { compileClaudeModelSelection } from "./claudeModelOptions.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-fable-5", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "ultracode" },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-fable-5[1m]",
      effort: "xhigh",
      settings: { ultracode: true },
    });
  });

  it("preserves xhigh effort and the 1M default context for Claude Fable 5.1", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-fable-5-1", [{ id: "effort", value: "xhigh" }]),
      ),
    ).toMatchObject({
      apiModelId: "claude-fable-5-1[1m]",
      effort: "xhigh",
      settings: {},
    });
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: true }]))
        .settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: false }]))
        .settings,
    ).toEqual({ fastMode: false });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});

it("compiles Opus 5.5 defaults and keeps adaptive thinking enabled", () => {
  expect(
    compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "thinking", value: false }])),
  ).toMatchObject({
    apiModelId: "claude-opus-5-5[1m]",
    effort: "medium",
    settings: {},
  });
  expect(
    compileClaudeModelSelection(
      selection("claude-opus-5-5", [
        { id: "effort", value: "xhigh" },
        { id: "fastMode", value: true },
      ]),
    ),
  ).toMatchObject({ effort: "xhigh", settings: { fastMode: true } });
});

it("executes options for models supplied only by a refreshed manifest", () => {
  const entry = BUNDLED_MODEL_MANIFEST.claudeModels![0]!;
  const remote = {
    ...BUNDLED_MODEL_MANIFEST,
    claudeModels: [{ ...entry, model: { ...entry.model, slug: "claude-future" } }],
  };
  expect(
    compileClaudeModelSelection(
      selection("claude-future", [
        { id: "effort", value: "xhigh" },
        { id: "fastMode", value: true },
      ]),
      remote,
    ),
  ).toMatchObject({
    apiModelId: "claude-future[1m]",
    effort: "xhigh",
    settings: { fastMode: true },
  });
});
