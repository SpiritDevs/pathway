// @effect-diagnostics nodeBuiltinImport:off -- Tests use isolated temporary desktop files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { DictationHistoryEntry } from "@spiritdevs/contracts/dictation";
import { DictationStorage } from "./DictationStorage.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "pathway-dictation-storage-"),
  );
  directories.push(directory);
  return new DictationStorage(directory);
}

function entry(id: string, createdAt: string): DictationHistoryEntry {
  return {
    id,
    createdAt,
    originalText: "Um, send this to path way.",
    text: "Send this to Pathway.",
    durationMs: 1400,
    modelId: "whisper-turbo",
    language: "en",
    cleanup: "applied",
    delivery: "inserted",
  };
}

describe("desktop dictation storage", () => {
  it("expires both text versions after the retention boundary without touching another account", async () => {
    const storage = await setup();
    const expired = entry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-08-12T23:59:59.999Z");
    const boundary = entry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "2026-08-13T00:00:00.000Z");
    const recent = entry("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "2026-09-11T12:00:00.000Z");
    await Promise.all([
      storage.saveHistory("first", expired),
      storage.saveHistory("first", boundary),
      storage.saveHistory("first", recent),
      storage.saveHistory("second", expired),
    ]);
    await storage.prune("first", 30, Date.parse("2026-09-12T00:00:00.000Z"));
    expect(await storage.history("first")).toEqual([recent, boundary]);
    expect(await storage.history("second")).toEqual([expired]);
    await storage.prune("first", 0, Date.parse("2030-01-01T00:00:00.000Z"));
    expect(await storage.history("first")).toEqual([recent, boundary]);
  });

  it("deletes one entry or all entries within only the selected account", async () => {
    const storage = await setup();
    const first = entry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-09-11T12:00:00.000Z");
    const second = entry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "2026-09-12T12:00:00.000Z");
    await Promise.all([
      storage.saveHistory("first", first),
      storage.saveHistory("first", second),
      storage.saveHistory("second", first),
    ]);
    await storage.deleteHistory("first", first.id);
    expect(await storage.history("first")).toEqual([second]);
    await storage.deleteHistory("first", null);
    expect(await storage.history("first")).toEqual([]);
    expect(await storage.history("second")).toEqual([first]);
  });

  it("keeps independent dictionary caches for each account", async () => {
    const storage = await setup();
    const lists = [
      {
        id: "work",
        name: "Work",
        terms: [{ id: "pathway", spelling: "Pathway", aliases: ["path way"] }],
      },
    ];
    await storage.saveDictionary("first", lists);
    expect(await storage.dictionary("first")).toEqual(lists);
    expect(await storage.dictionary("second")).toEqual([]);
    await storage.saveDictionary("first", []);
    expect(await storage.dictionary("first")).toEqual([]);
  });
});
