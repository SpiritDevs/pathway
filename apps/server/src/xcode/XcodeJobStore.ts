// @effect-diagnostics nodeBuiltinImport:off -- Atomic fsync and rename at the injectable job storage boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { XcodeJob } from "@spiritdevs/contracts/xcode";
import { type XcodeJobStore, xcodeError } from "./XcodeInstall.ts";
const decodeJob = Schema.decodeUnknownSync(Schema.fromJsonString(XcodeJob));
export function fileXcodeJobStore(path: string): XcodeJobStore {
  return {
    async load() {
      try {
        return decodeJob(await NodeFSP.readFile(path, "utf8"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw xcodeError(
          "storage-failed",
          "The saved Xcode job could not be read. Preserve it for recovery.",
        );
      }
    },
    async save(job) {
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
      const file = await NodeFSP.open(`${path}.tmp`, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(job));
        await file.sync();
      } finally {
        await file.close();
      }
      await NodeFSP.rename(`${path}.tmp`, path);
    },
  };
}
