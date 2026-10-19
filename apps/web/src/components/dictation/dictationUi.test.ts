import { describe, expect, it } from "vite-plus/test";
import { DictationState } from "@spiritdevs/contracts/dictation";
import * as Schema from "effect/Schema";
import {
  dictionaryValidation,
  dictationReadiness,
  dictationSettingsPathVisible,
  normalizeDictionary,
} from "./dictationUi";
import { dictationFixtureNames, makeDictationFixture } from "./fixtures";

const decodeState = Schema.decodeUnknownSync(DictationState);

describe("dictation readiness", () => {
  it("requires a verified installed selected speech model, even when another model is installed", () => {
    const state = makeDictationFixture();
    expect(dictationReadiness(state)).toEqual([]);
    for (const status of ["missing", "downloading", "verifying", "error"] as const) {
      expect(
        dictationReadiness({
          ...state,
          models: state.models.map((model) =>
            model.id === state.preferences.speechModel ? { ...model, status } : model,
          ),
        }),
      ).toContain("Download and select a speech model.");
    }
  });
  it("allows transcript delivery with cleanup unavailable, but rejects a missing fixed microphone", () => {
    const state = makeDictationFixture();
    expect(
      dictationReadiness({
        ...state,
        models: state.models.filter((model) => model.kind === "speech"),
      }),
    ).toEqual([]);
    expect(
      dictationReadiness({
        ...state,
        preferences: { ...state.preferences, microphoneId: "removed" },
      }),
    ).toContain("Your selected microphone is disconnected. Choose an available input.");
  });
  it("does not mistake downloaded models for permission or account readiness", () => {
    const state = makeDictationFixture();
    expect(
      dictationReadiness({
        ...state,
        microphonePermission: "denied",
        accessibilityPermission: "unknown",
        authenticated: false,
      }),
    ).toHaveLength(3);
  });
});

describe("dictionary editing", () => {
  it("trims entries and removes blank lines without losing phrase corrections", () => {
    const lists = [
      {
        id: "list",
        name: " Work ",
        terms: [
          {
            id: "term",
            spelling: " Pathway ",
            aliases: [" path way ", "", "path way", "  pathway app  "],
          },
        ],
      },
    ];
    expect(normalizeDictionary(lists)[0]?.terms[0]).toEqual({
      id: "term",
      spelling: "Pathway",
      aliases: ["path way", "pathway app"],
    });
    expect(dictionaryValidation(lists)).toBeNull();
    expect(lists[0]?.name).toBe(" Work ");
  });
  it("rejects conflicting corrections across lists before saving", () => {
    expect(
      dictionaryValidation([
        {
          id: "one",
          name: "Work",
          terms: [{ id: "term-one", spelling: "Pathway", aliases: ["path way"] }],
        },
        {
          id: "two",
          name: "Personal",
          terms: [{ id: "term-two", spelling: "Pathways", aliases: ["PATH WAY"] }],
        },
      ]),
    ).toContain("more than one spelling");
  });
  it("allows empty lists and rejects blank terms and too many aliases", () => {
    expect(dictionaryValidation([{ id: "list", name: "People", terms: [] }])).toBeNull();
    expect(
      dictionaryValidation([
        { id: "list", name: "People", terms: [{ id: "term", spelling: " ", aliases: [] }] },
      ]),
    ).not.toBeNull();
    expect(
      dictionaryValidation([
        {
          id: "list",
          name: "People",
          terms: [
            {
              id: "term",
              spelling: "Maya",
              aliases: Array.from({ length: 9 }, (_, index) => `alias ${index}`),
            },
          ],
        },
      ]),
    ).not.toBeNull();
  });
});

describe("dictation navigation", () => {
  it("hides all dictation pages on unsupported clients and shows one setup destination before setup", () => {
    for (const page of ["", "/models", "/history", "/dictionary", "/settings"])
      expect(dictationSettingsPathVisible(`/settings/dictation${page}`, "unavailable")).toBe(false);
    expect(dictationSettingsPathVisible("/settings/dictation", "setup")).toBe(true);
    expect(dictationSettingsPathVisible("/settings/dictation/history", "setup")).toBe(false);
    expect(dictationSettingsPathVisible("/settings/dictation/history", "ready")).toBe(true);
    expect(dictationSettingsPathVisible("/settings/general", "unavailable")).toBe(true);
  });
  it("keeps every screenshot configuration valid against the real IPC schema", () => {
    for (const name of dictationFixtureNames)
      expect(() => decodeState(makeDictationFixture(name))).not.toThrow();
  });
});
