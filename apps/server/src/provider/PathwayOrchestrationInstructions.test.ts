import { assert, describe, it } from "@effect/vitest";

import {
  PATHWAY_ORCHESTRATION_INSTRUCTIONS,
  pathwayOrchestrationPromptForFirstRun,
  pathwayOrchestrationSystemPrompt,
} from "./PathwayOrchestrationInstructions.ts";

describe("Pathway orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(PATHWAY_ORCHESTRATION_INSTRUCTIONS, "use `delegate_task`");
    assert.include(PATHWAY_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level Pathway conversations");
    assert.include(PATHWAY_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(PATHWAY_ORCHESTRATION_INSTRUCTIONS, "different provider");
    assert.include(PATHWAY_ORCHESTRATION_INSTRUCTIONS, "pass that provider and model in `target`");
    assert.include(
      PATHWAY_ORCHESTRATION_INSTRUCTIONS,
      "launches another provider's CLI through Bash or a wrapper",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(PATHWAY_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(PATHWAY_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(PATHWAY_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = pathwayOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasPathwayMcp: true,
    });

    assert.include(injected, "<pathway_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      pathwayOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasPathwayMcp: true }),
      prompt,
    );
    assert.equal(
      pathwayOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasPathwayMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Pathway MCP server is attached", () => {
    assert.equal(pathwayOrchestrationSystemPrompt(false), undefined);
    assert.equal(pathwayOrchestrationSystemPrompt(true), PATHWAY_ORCHESTRATION_INSTRUCTIONS);
  });
});
