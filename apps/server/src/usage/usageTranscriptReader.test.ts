// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";

describe("transcript scan coverage", () => {
  it("retains valid totals and counts malformed usage records", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-"));
    try {
      const file = NodePath.join(dir, "session.jsonl");
      await NodeFSP.writeFile(
        file,
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-09-05T00:00:00Z",
            sessionId: "s",
            message: {
              id: "m",
              model: "claude-fable-5",
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }),
          '{"type":"assistant", "usage":',
        ].join("\n"),
      );
      const result = await readTranscriptRecords(file, "claude");
      expect(result.records).toHaveLength(1);
      expect(result.malformedRecords).toBe(1);
      expect(result.failed).toBe(false);
      expect((await readTranscriptRecords(NodePath.join(dir, "gone.jsonl"), "claude")).failed).toBe(
        true,
      );
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
  it("distinguishes an unreadable directory from a successful empty listing", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-listing-"));
    try {
      expect(await listTranscriptFiles(dir, 0)).toEqual({ files: [], failedEntries: 0 });
      const notDirectory = NodePath.join(dir, "not-a-directory");
      await NodeFSP.writeFile(notDirectory, "");
      expect(await listTranscriptFiles(notDirectory, 0)).toEqual({ files: [], failedEntries: 1 });
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
