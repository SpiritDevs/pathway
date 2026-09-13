import { describe, expect, it } from "vite-plus/test";
import {
  acceptableDictationCleanup,
  applyDictationDictionary,
  cleanRecognizedText,
} from "./textProcessing.ts";

const dictionary = [
  {
    id: "list",
    name: "Work",
    terms: [
      { id: "one", spelling: "Pathway", aliases: ["path way"] },
      { id: "two", spelling: "Product", aliases: ["Pathway"] },
    ],
  },
];
describe("dictation text processing", () => {
  it("applies longest phrases once without cascading or changing substrings", () => {
    expect(applyDictationDictionary("Use path way and pathwayish", dictionary)).toBe(
      "Use Pathway and pathwayish",
    );
  });
  it("normalizes preferred spelling and preserves Unicode word boundaries", () => {
    expect(
      applyDictationDictionary(
        "pathway uses épathway and path way.",
        dictionary.slice(0, 1).map((list) => ({ ...list, terms: list.terms.slice(0, 1) })),
      ),
    ).toBe("Pathway uses épathway and Pathway.");
  });
  it("does not deliver silence markers or model control tokens", () => {
    expect(cleanRecognizedText(" [NO_SPEECH] ")).toBe("");
    expect(cleanRecognizedText("<|start|>Hello  there")).toBe("Hello there");
  });
  it("rejects invented numbers, removed negation and response commentary", () => {
    expect(acceptableDictationCleanup("Do not send 12 files", "Send 12 files", [])).toBe(false);
    expect(acceptableDictationCleanup("Send 12 files", "Send 13 files", [])).toBe(false);
    expect(
      acceptableDictationCleanup("Hello there", "Here is the corrected text: Hello there", []),
    ).toBe(false);
  });
  it("rejects short translations and structured model replies", () => {
    expect(acceptableDictationCleanup("Bonjour demain", "Hello tomorrow", [])).toBe(false);
    expect(acceptableDictationCleanup("Bonjour demain", '{"text":"Bonjour demain"}', [])).toBe(
      false,
    );
    expect(acceptableDictationCleanup("Bonjour demain", "Bonjour demain.", [])).toBe(true);
  });
  it("permits an explicit spoken correction without inventing its replacement", () => {
    expect(
      acceptableDictationCleanup("Send 12 files, actually send 13 files", "Send 13 files", []),
    ).toBe(true);
    expect(
      acceptableDictationCleanup("Send 12 files, actually send 13 files", "Send 12 files", []),
    ).toBe(false);
    expect(
      acceptableDictationCleanup("Envíalo el martes, perdón, el jueves", "Envíalo el martes", []),
    ).toBe(false);
    expect(
      acceptableDictationCleanup("Envíalo el martes, perdón, el jueves", "Envíalo el jueves", []),
    ).toBe(true);
  });
  it.each(["I mean", "I meant"])(
    "removes the full correction cue %s while preserving the corrected content",
    (cue) => {
      const original = `Prepare six boxes. Sorry, ${cue} eight boxes. Then label the remaining boxes.`;
      expect(
        acceptableDictationCleanup(
          original,
          "Prepare eight boxes. Then label the remaining boxes.",
          [],
        ),
      ).toBe(true);
      expect(
        acceptableDictationCleanup(
          original,
          "Prepare six boxes. Then label the remaining boxes.",
          [],
        ),
      ).toBe(false);
    },
  );
});
