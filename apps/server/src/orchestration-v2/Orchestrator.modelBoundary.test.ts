import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";

import { crossesProviderOrModelBoundary } from "./Orchestrator.ts";

const codex = ProviderInstanceId.make("codex");
const fable = ProviderInstanceId.make("fable");
const providerThread = {
  id: ProviderThreadId.make("provider-thread:model-boundary"),
  providerInstanceId: codex,
  lastRunOrdinal: 2,
} as OrchestrationV2ProviderThread;

function projection(model: string): OrchestrationV2ThreadProjection {
  return {
    runs: [
      {
        id: RunId.make("run:model-boundary:completed"),
        ordinal: 1,
        status: "completed",
        modelSelection: { instanceId: codex, model: "gpt-5.5" },
      },
      {
        id: RunId.make("run:model-boundary:interrupted"),
        ordinal: 2,
        status: "interrupted",
        modelSelection: { instanceId: codex, model },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("uses the run assigned to the active provider thread after an interrupted switch", () => {
  assert.isFalse(
    crossesProviderOrModelBoundary({
      projection: projection("gpt-5.6-sol"),
      activeProviderThread: providerThread,
      modelSelection: { instanceId: codex, model: "gpt-5.6-sol" },
    }),
  );
  assert.isTrue(
    crossesProviderOrModelBoundary({
      projection: projection("gpt-5.5"),
      activeProviderThread: providerThread,
      modelSelection: { instanceId: codex, model: "gpt-5.6-sol" },
    }),
  );
});

it("compacts for provider changes but ignores option-only changes", () => {
  const current = projection("gpt-5.6-sol");
  assert.isTrue(
    crossesProviderOrModelBoundary({
      projection: current,
      activeProviderThread: providerThread,
      modelSelection: { instanceId: fable, model: "claude-opus-4-1" },
    }),
  );
  assert.isFalse(
    crossesProviderOrModelBoundary({
      projection: current,
      activeProviderThread: providerThread,
      modelSelection: {
        instanceId: codex,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    }),
  );
});
