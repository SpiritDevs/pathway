// @effect-diagnostics nodeBuiltinImport:off -- Atomic receipt journal storage boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { SimBuildReceipt, SimBuildError } from "@spiritdevs/contracts/simBuild";
/** Request tombstones outlive the bounded receipt history. Hashes keep the index compact. */
const SimBuildRequestRecord = Schema.Struct({
  key: Schema.String,
  fingerprint: Schema.String,
  jobId: Schema.String,
});
export type SimBuildRequestRecord = typeof SimBuildRequestRecord.Type;
const SimBuildJournal = Schema.Struct({
  receipts: Schema.Array(SimBuildReceipt),
  requests: Schema.Array(SimBuildRequestRecord),
});
export type SimBuildJournal = typeof SimBuildJournal.Type;
export interface SimBuildStore {
  load(): Promise<SimBuildJournal>;
  save(journal: SimBuildJournal): Promise<void>;
}
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([SimBuildJournal, Schema.Array(SimBuildReceipt)])),
);
export const fileSimBuildStore = (file: string): SimBuildStore => ({
  async load() {
    try {
      const saved = decode(await NodeFSP.readFile(file, "utf8"));
      // Older journals contained only receipts. The runtime seeds their request index.
      return "receipts" in saved ? saved : { receipts: saved, requests: [] };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { receipts: [], requests: [] };
      throw new SimBuildError({
        code: "storage-failed",
        message: "Could not read the simulator build receipts. Preserve the journal for recovery.",
      });
    }
  },
  async save(journal) {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await NodeFSP.open(`${file}.tmp`, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(journal));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(`${file}.tmp`, file);
  },
});
