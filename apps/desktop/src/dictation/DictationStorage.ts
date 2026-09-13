// @effect-diagnostics nodeBuiltinImport:off -- Desktop-owned files never use an environment's database.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  DictationPreferences,
  DictationDictionaryList,
  DictationHistoryEntry,
  defaultDictationPreferences,
} from "@spiritdevs/contracts/dictation";

const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export class DictationStorage {
  private writes = Promise.resolve();
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  private accountDirectory(accountId: string) {
    return NodePath.join(
      this.directory,
      "accounts",
      NodeCrypto.createHash("sha256").update(accountId).digest("hex"),
    );
  }

  private async read<A>(file: string, decode: (value: unknown) => A, fallback: A): Promise<A> {
    try {
      return decode(JSON.parse(await NodeFSP.readFile(file, "utf8")));
    } catch (error) {
      if (isMissing(error)) return fallback;
      throw error;
    }
  }

  private write(file: string, value: unknown) {
    const operation = this.writes.then(async () => {
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await NodeFSP.rename(temporary, file);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    });
    this.writes = operation.catch(() => {});
    return operation;
  }

  preferences(platform: string) {
    return this.read(
      NodePath.join(this.directory, "preferences.json"),
      Schema.decodeUnknownSync(DictationPreferences),
      defaultDictationPreferences(platform),
    );
  }
  savePreferences(value: DictationPreferences) {
    return this.write(NodePath.join(this.directory, "preferences.json"), value);
  }
  dictionary(accountId: string) {
    return this.read(
      NodePath.join(this.accountDirectory(accountId), "dictionary.json"),
      Schema.decodeUnknownSync(Schema.Array(DictationDictionaryList)),
      [],
    );
  }
  saveDictionary(accountId: string, value: readonly DictationDictionaryList[]) {
    return this.write(NodePath.join(this.accountDirectory(accountId), "dictionary.json"), value);
  }

  async history(accountId: string): Promise<readonly DictationHistoryEntry[]> {
    await this.writes;
    const directory = NodePath.join(this.accountDirectory(accountId), "history");
    let files: string[];
    try {
      files = await NodeFSP.readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const entries: DictationHistoryEntry[] = [];
    for (const name of files
      .filter((file) => /^\d+_[\da-f-]+\.json$/.test(file))
      .sort()
      .toReversed()) {
      const entry = await this.read(
        NodePath.join(directory, name),
        Schema.decodeUnknownSync(Schema.NullOr(DictationHistoryEntry)),
        null,
      );
      if (entry) entries.push(entry);
    }
    return entries;
  }
  saveHistory(accountId: string, entry: DictationHistoryEntry) {
    if (!/^[\da-f-]+$/.test(entry.id)) throw new Error("Invalid dictation history ID.");
    return this.write(
      NodePath.join(
        this.accountDirectory(accountId),
        "history",
        `${Date.parse(entry.createdAt)}_${entry.id}.json`,
      ),
      entry,
    );
  }
  async deleteHistory(accountId: string, id: string | null) {
    await this.writes;
    const directory = NodePath.join(this.accountDirectory(accountId), "history");
    let files: string[];
    try {
      files = await NodeFSP.readdir(directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of files.filter((file) => /^\d+_[\da-f-]+\.json$/.test(file))) {
      if (id === null || name.endsWith(`_${id}.json`))
        await NodeFSP.rm(NodePath.join(directory, name), { force: true });
    }
  }
  async prune(accountId: string, retentionDays: number, now: number) {
    if (retentionDays === 0) return;
    await this.writes;
    const directory = NodePath.join(this.accountDirectory(accountId), "history");
    let files: string[];
    try {
      files = await NodeFSP.readdir(directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const cutoff = now - retentionDays * 86_400_000;
    for (const name of files) {
      if (/^\d+_[\da-f-]+\.json$/.test(name) && Number(name.split("_")[0]) < cutoff)
        await NodeFSP.rm(NodePath.join(directory, name), { force: true });
    }
  }
  flush() {
    return this.writes;
  }
}
