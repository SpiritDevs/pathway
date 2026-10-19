import { describe, expect, it } from "vite-plus/test";
import { agentTimeSummaryPrompt, parseAgentTimeSummary } from "./agentTimeSummary.ts";
describe("time entry summaries", () => {
  it("accepts fenced JSON and keeps a separate title and activity description", () => {
    expect(
      parseAgentTimeSummary(
        '```json\n{"title":"Fix checkout recovery", "description":"Added stash and retry actions. Verified checkout conflicts."}\n```',
      ),
    ).toEqual({
      title: "Fix checkout recovery",
      description: "Added stash and retry actions. Verified checkout conflicts.",
    });
  });
  it("rejects malformed or empty summaries instead of publishing them", () => {
    expect(() => parseAgentTimeSummary("done")).toThrow();
    expect(() => parseAgentTimeSummary('{"title":" ","description":"done"}')).toThrow();
    expect(agentTimeSummaryPrompt("test activity")).toContain("Do not invent results");
  });
});
