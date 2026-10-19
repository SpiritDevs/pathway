import { describe, expect, it } from "vite-plus/test";

import { integrationsAnchorForLegacyIntakeHash } from "./settings.issues-intake";

describe("legacy Triage & Intake redirect", () => {
  it("maps known Slack anchors and preserves the automation anchor", () => {
    expect(integrationsAnchorForLegacyIntakeHash("#slack-bot-token")).toBe("issue-intake");
    expect(integrationsAnchorForLegacyIntakeHash("slack-watched-channels")).toBe("issue-intake");
    expect(integrationsAnchorForLegacyIntakeHash("issue-intake-automation")).toBe(
      "issue-intake-automation",
    );
  });
});
