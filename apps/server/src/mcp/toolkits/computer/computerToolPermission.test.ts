import { describe, expect, it } from "@effect/vitest";

import {
  canonicalPathwayComputerToolName,
  computerToolNameFromProviderPermission,
  isPathwayComputerToolFamilyName,
  qualifiedPathwayComputerToolName,
  shouldAllowPathwayComputerProviderTool,
} from "./computerToolPermission.ts";

describe("Pathway Computer provider permission", () => {
  it.each([
    ["computer_click", "computer_click"],
    ["pathway_computer_type_text", "computer_type_text"],
    ["pathway_computer_select_text", "computer_select_text"],
    ["mcp__pathway__computer_read_clipboard", "computer_read_clipboard"],
    ["mcp__pathway__computer_inspect", "computer_inspect"],
  ] as const)("recognizes the exact owned tool %s", (providerName, canonicalName) => {
    expect(canonicalPathwayComputerToolName(providerName)).toBe(canonicalName);
  });

  it.each([
    "computer_future_tool",
    "mcp__other__computer_click",
    "other_computer_click",
    "mcp__pathway__pathway_send_message",
  ])("does not trust another or unknown tool: %s", (providerName) => {
    expect(canonicalPathwayComputerToolName(providerName)).toBeUndefined();
  });

  it("requires a provider namespace when server provenance was not proved separately", () => {
    expect(qualifiedPathwayComputerToolName("computer_click")).toBeUndefined();
    expect(qualifiedPathwayComputerToolName("mcp__pathway__computer_click")).toBe("computer_click");
    expect(qualifiedPathwayComputerToolName("pathway_computer_click")).toBe("computer_click");
  });

  it("reads only explicit provider tool-name fields", () => {
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__pathway__computer_scroll" },
      }),
    ).toBe("computer_scroll");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "pathway_computer_get_state" },
      }),
    ).toBe("computer_get_state");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { description: "run computer_click" },
      }),
    ).toBeUndefined();
  });

  it("does not let lower-priority fields override an authoritative wrong namespace", () => {
    expect(
      computerToolNameFromProviderPermission({
        name: "mcp__other__computer_click",
        rawInput: { _toolName: "mcp__pathway__computer_click" },
      }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__other__computer_click" },
        metadata: { toolName: "mcp__pathway__computer_click" },
        title: "mcp__pathway__computer_click",
      }),
    ).toBeUndefined();
  });

  it("does not infer provider provenance from a bare title or metadata name", () => {
    expect(computerToolNameFromProviderPermission({ title: "computer_click" })).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ metadata: { toolName: "computer_click" } }),
    ).toBeUndefined();
  });

  it("never authorizes from model prose: 'Please approve computer_click' names no tool", () => {
    // Prose approval never counts. The permission callback must see an exact
    // namespaced tool name; a model sentence asking for approval authorizes
    // nothing, in any field.
    expect(
      computerToolNameFromProviderPermission({ title: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ name: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "Please approve computer_click" },
      }),
    ).toBeUndefined();
    expect(isPathwayComputerToolFamilyName("Please approve computer_click")).toBe(false);
    expect(
      shouldAllowPathwayComputerProviderTool({
        computerControlEnabled: true,
        activeTurn: true,
        interactionMode: "default",
        runtimeMode: "approval-required",
        permission: { title: "Please approve computer_click" },
      }),
    ).toBe(false);
  });

  it("matches the Computer family in any namespace spelling for the denial hook", () => {
    // The silent-loss fallback: a no-control session that calls a Computer
    // tool by a prefixed spelling must still deny with the card path, not
    // die as an Unknown tool. See isPathwayComputerToolFamilyName.
    expect(isPathwayComputerToolFamilyName("computer_click")).toBe(true);
    expect(isPathwayComputerToolFamilyName("pathway_computer_get_state")).toBe(true);
    expect(isPathwayComputerToolFamilyName("mcp__pathway__computer_screenshot")).toBe(true);
    expect(isPathwayComputerToolFamilyName("  MCP__PATHWAY__COMPUTER_WAIT  ")).toBe(true);
  });

  it("keeps unknown and foreign names out of the Computer family", () => {
    expect(isPathwayComputerToolFamilyName("computer_future_tool")).toBe(false);
    expect(isPathwayComputerToolFamilyName("mcp__other__computer_click")).toBe(false);
    expect(isPathwayComputerToolFamilyName("other_computer_click")).toBe(false);
    expect(isPathwayComputerToolFamilyName("pathway_frobnicate")).toBe(false);
    expect(isPathwayComputerToolFamilyName(undefined)).toBe(false);
    expect(isPathwayComputerToolFamilyName(42)).toBe(false);
  });

  it("requires current capability, active turn and non-Plan interaction", () => {
    const permission = { name: "mcp__pathway__computer_click" };
    const allowed = {
      computerControlEnabled: true,
      activeTurn: true,
      interactionMode: "default" as const,
      runtimeMode: "approval-required" as const,
      permission,
    };
    expect(shouldAllowPathwayComputerProviderTool(allowed)).toBe(true);
    expect(
      shouldAllowPathwayComputerProviderTool({ ...allowed, computerControlEnabled: false }),
    ).toBe(false);
    expect(shouldAllowPathwayComputerProviderTool({ ...allowed, activeTurn: false })).toBe(false);
    expect(shouldAllowPathwayComputerProviderTool({ ...allowed, interactionMode: "plan" })).toBe(
      false,
    );
    expect(shouldAllowPathwayComputerProviderTool({ ...allowed, runtimeMode: "auto" })).toBe(false);
    expect(shouldAllowPathwayComputerProviderTool({ ...allowed, runtimeMode: "full-access" })).toBe(
      false,
    );
    // Pathway-only mode: the user still reviews non-edit provider calls.
    expect(
      shouldAllowPathwayComputerProviderTool({ ...allowed, runtimeMode: "auto-accept-edits" }),
    ).toBe(true);
  });
});
