// @effect-diagnostics nodeBuiltinImport:off -- Atomic environment-local job and archive metadata storage.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { LocalReleaseArchive, ReleaseJob } from "@spiritdevs/contracts/releases";
import { releaseError } from "./ReleaseHost.ts";
export const ReleaseState = Schema.Struct({
  archives: Schema.Array(LocalReleaseArchive),
  jobs: Schema.Array(ReleaseJob),
});
export type ReleaseState = typeof ReleaseState.Type;
export interface ReleaseStore {
  load(): Promise<ReleaseState>;
  save(state: ReleaseState): Promise<void>;
}
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseState));
export function fileReleaseStore(filePath: string): ReleaseStore {
  return {
    async load() {
      try {
        return decodeState(await NodeFSP.readFile(filePath, "utf8"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return { jobs: [], archives: [] };
        throw releaseError(
          "storage-failed",
          "Release state could not be read. Preserve it for recovery.",
        );
      }
    },
    async save(state) {
      try {
        await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
        const file = await NodeFSP.open(`${filePath}.tmp`, "w", 0o600);
        try {
          await file.writeFile(JSON.stringify(state));
          await file.sync();
        } finally {
          await file.close();
        }
        await NodeFSP.rename(`${filePath}.tmp`, filePath);
      } catch {
        throw releaseError("storage-failed", "Release state could not be saved.");
      }
    },
  };
}
