import { describe, expect, it } from "vite-plus/test";

import {
  applyPromptEffortKeepingComputerUse,
  buildBuiltInSlashCommandItems,
  isBareComputerUseInvocation,
  shouldHideProviderNativeSlashCommand,
} from "./composerSlashCommands.logic";

describe("buildBuiltInSlashCommandItems", () => {
  it("offers /computer-use exactly once where Computer is supported", () => {
    const items = buildBuiltInSlashCommandItems({ computerUseAvailable: true });
    expect(items.map((item) => item.label)).toEqual([
      "/model",
      "/plan",
      "/default",
      "/computer-use",
    ]);
    expect(items.filter((item) => item.command === "computer-use")).toEqual([
      {
        id: "slash:computer-use",
        type: "slash-command",
        command: "computer-use",
        label: "/computer-use",
        description: "Use Pathway Computer for this request only",
      },
    ]);
  });

  it("leaves /computer-use out where Computer is unsupported", () => {
    const items = buildBuiltInSlashCommandItems({ computerUseAvailable: false });
    expect(items.some((item) => item.command === "computer-use")).toBe(false);
  });
});

describe("shouldHideProviderNativeSlashCommand", () => {
  it("hides a provider's own computer-use command in favour of Pathway's", () => {
    expect(shouldHideProviderNativeSlashCommand("computer-use")).toBe(true);
    expect(shouldHideProviderNativeSlashCommand("/Computer-Use")).toBe(true);
    expect(shouldHideProviderNativeSlashCommand("review")).toBe(false);
  });
});

describe("isBareComputerUseInvocation", () => {
  it("detects /computer-use with no task", () => {
    expect(isBareComputerUseInvocation("/computer-use")).toBe(true);
    expect(isBareComputerUseInvocation("  /computer-use  ")).toBe(true);
    expect(isBareComputerUseInvocation("/computer-use open Calculator")).toBe(false);
    expect(isBareComputerUseInvocation("open Calculator")).toBe(false);
  });
});

describe("applyPromptEffortKeepingComputerUse", () => {
  it("keeps /computer-use first when Ultrathink is prefixed", () => {
    expect(applyPromptEffortKeepingComputerUse("/computer-use open Calculator", "ultrathink")).toBe(
      "/computer-use Ultrathink:\nopen Calculator",
    );
  });

  it("prefixes ordinary prompts as before", () => {
    expect(applyPromptEffortKeepingComputerUse("open Calculator", "ultrathink")).toBe(
      "Ultrathink:\nopen Calculator",
    );
  });

  it("leaves text alone without a prompt-injected effort", () => {
    expect(applyPromptEffortKeepingComputerUse("/computer-use open Calculator", null)).toBe(
      "/computer-use open Calculator",
    );
    expect(applyPromptEffortKeepingComputerUse("  open Calculator  ", null)).toBe(
      "open Calculator",
    );
  });
});
