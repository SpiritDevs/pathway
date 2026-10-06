import { assert, it } from "@effect/vitest";
import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

for (const mode of ["plan", "default"] as const) {
  it(`includes the small HTML guidance once in Codex ${mode} mode`, () => {
    const instructions = buildCodexDeveloperInstructions(mode, {
      model: "gpt-6",
      reasoningEffort: "high",
    });
    assert.include(instructions, "html_preview");
    assert.include(instructions, "html_render");
    assert.equal(instructions.split("## Inline HTML pages").length, 2);
    assert.equal(instructions.includes("## Pathway orchestration"), mode === "default");
  });
}
