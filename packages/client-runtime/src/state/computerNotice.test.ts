import { describe, expect, it } from "vite-plus/test";

import { computerNoticeOfTurnItem } from "./computerNotice.ts";

const dynamicTool = (toolName: string | null, input: unknown) =>
  ({ type: "dynamic_tool", toolName, input }) as const;

describe("computerNoticeOfTurnItem", () => {
  it("reads a setup notice with its grants and build identity", () => {
    expect(
      computerNoticeOfTurnItem(
        dynamicTool("computer_setup_required", {
          toolName: "computer_click",
          missing: ["accessibility", "screenRecording"],
          buildSignature: "adhoc",
          bundleId: "com.spiritdevs.pathway.dev",
        }),
      ),
    ).toEqual({
      kind: "setup-required",
      missing: ["accessibility", "screenRecording"],
      buildSignature: "adhoc",
      bundleId: "com.spiritdevs.pathway.dev",
    });
  });

  it("still reports setup when the payload does not decode, without naming grants", () => {
    expect(
      computerNoticeOfTurnItem(dynamicTool("computer_setup_required", { missing: ["bogus"] })),
    ).toEqual({ kind: "setup-required", missing: [] });
  });

  it("reads a control-denied notice and its tool", () => {
    expect(
      computerNoticeOfTurnItem(
        dynamicTool("computer_capability_denied", { toolName: " computer_click " }),
      ),
    ).toEqual({ kind: "control-denied", toolName: "computer_click" });
    expect(computerNoticeOfTurnItem(dynamicTool("computer_capability_denied", null))).toEqual({
      kind: "control-denied",
      toolName: null,
    });
  });

  it("ignores ordinary tool calls and other item types", () => {
    expect(computerNoticeOfTurnItem(dynamicTool("mcp__pathway__computer_click", {}))).toBeNull();
    expect(computerNoticeOfTurnItem({ type: "reasoning" })).toBeNull();
  });
});
