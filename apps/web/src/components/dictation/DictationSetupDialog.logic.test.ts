import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DictationCommand } from "@spiritdevs/contracts/dictation";
import { makeDictationFixture } from "./fixtures";
import {
  dictationPermissionCommand,
  dictationSetupAccessReady,
  dictationSetupCanFinish,
  dictationSetupCanVisit,
  dictationSetupInitialStep,
  dictationSetupModelsReady,
} from "./DictationSetupDialog.logic";

const decodeCommand = Schema.decodeUnknownSync(DictationCommand);

describe("dictation setup progression", () => {
  it("requires microphone and Accessibility on Mac before models or a test", () => {
    const state = makeDictationFixture("setup");
    expect(dictationSetupInitialStep(state, "test")).toBe("access");
    expect(dictationSetupCanVisit(state, "models")).toBe(false);
    expect(dictationSetupCanVisit({ ...state, microphonePermission: "granted" }, "models")).toBe(
      false,
    );
    expect(dictationSetupAccessReady(makeDictationFixture("setup-access-ready"))).toBe(true);
  });
  it("offers the Windows microphone flow without asking for a macOS Accessibility grant", () => {
    const state = makeDictationFixture("setup-windows");
    expect(dictationSetupInitialStep(state)).toBe("access");
    expect(
      dictationSetupAccessReady({
        ...state,
        microphonePermission: "granted",
        accessibilityPermission: "unknown",
      }),
    ).toBe(true);
  });
  it("resumes at missing models or the microphone test using existing downloads", () => {
    expect(dictationSetupInitialStep(makeDictationFixture("setup-models"))).toBe("models");
    expect(dictationSetupInitialStep(makeDictationFixture("setup-test"))).toBe("test");
    expect(dictationSetupInitialStep(makeDictationFixture("setup-test"), "access")).toBe("access");
    expect(dictationSetupInitialStep(makeDictationFixture("permissions-denied"), "test")).toBe(
      "access",
    );
  });
  it("waits for both downloads to finish verification without requiring a microphone test", () => {
    const state = makeDictationFixture("setup-test");
    expect(dictationSetupCanFinish(state)).toBe(true);
    for (const status of ["missing", "downloading", "verifying", "error"] as const) {
      const incomplete = {
        ...state,
        models: state.models.map((model) =>
          model.id === "qwen-cleanup" ? { ...model, status } : model,
        ),
      };
      expect(dictationSetupModelsReady(incomplete)).toBe(false);
      expect(dictationSetupCanFinish(incomplete)).toBe(false);
    }
  });
  it("prevents finishing during capture or with a disconnected microphone", () => {
    const state = makeDictationFixture("setup-test");
    expect(dictationSetupCanFinish(makeDictationFixture("setup-test-recording"))).toBe(false);
    expect(dictationSetupCanFinish({ ...state, phase: "processing" })).toBe(false);
    expect(
      dictationSetupCanFinish({
        ...state,
        preferences: { ...state.preferences, microphoneId: "disconnected" },
      }),
    ).toBe(false);
  });
  it("uses explicit canonical actions so a refresh cannot request both permissions", () => {
    for (const action of ["microphone", "accessibility", "refresh"] as const)
      expect(decodeCommand(dictationPermissionCommand(action))).toEqual({
        type: "permissions",
        action,
      });
  });
});
