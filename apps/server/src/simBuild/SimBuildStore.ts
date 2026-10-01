// @effect-diagnostics nodeBuiltinImport:off -- Atomic receipt journal storage boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { SimBuildReceipt, SimBuildError } from "@spiritdevs/contracts/simBuild";
export interface SimBuildStore {
  load(): Promise<readonly SimBuildReceipt[]>;
  save(receipts: readonly SimBuildReceipt[]): Promise<void>;
}
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SimBuildReceipt)));
export const fileSimBuildStore = (file: string): SimBuildStore => ({
  async load() {
    try {
      return decode(await NodeFSP.readFile(file, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new SimBuildError({
        code: "storage-failed",
        message: "Could not read the simulator build receipts. Preserve the journal for recovery.",
      });
    }
  },
  async save(receipts) {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await NodeFSP.open(`${file}.tmp`, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(receipts));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(`${file}.tmp`, file);
  },
});
