// @effect-diagnostics nodeBuiltinImport:off -- Integration test uses owned temporary media fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { previewCommands, runPreviewCommand } from "./assetPreviewProcessor.ts";

describe("asset preview conversion", () => {
  it.skipIf(NodeChildProcess.spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0)(
    "produces a compatible PNG using a bounded local-file invocation",
    async () => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "pathway-preview-test-"),
      );
      try {
        const input = NodePath.join(directory, "input.ppm");
        await NodeFSP.writeFile(
          input,
          Buffer.concat([
            Buffer.from("P6\n2048 2048\n255\n"),
            NodeCrypto.randomBytes(2048 * 2048 * 3),
          ]),
        );
        const [command] = previewCommands(input, directory, "image/heic");
        expect(command!.args).toContain("file,pipe");
        await runPreviewCommand([...command!.args, command!.path], new AbortController().signal);
        expect((await NodeFSP.stat(command!.path)).size).toBeLessThanOrEqual(10 * 1024 * 1024);
        const png = await NodeFSP.readFile(command!.path);
        expect(png.readUInt32BE(16)).toBe(1536);
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(NodeChildProcess.spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0)(
    "converts WAV to a compatible inline audio representation",
    async () => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "pathway-audio-test-"),
      );
      try {
        const header = Buffer.alloc(44);
        const bytes = 16000;
        header.write("RIFF", 0);
        header.writeUInt32LE(36 + bytes, 4);
        header.write("WAVEfmt ", 8);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(8000, 24);
        header.writeUInt32LE(16000, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write("data", 36);
        header.writeUInt32LE(bytes, 40);
        const input = NodePath.join(directory, "original.wav");
        await NodeFSP.writeFile(input, Buffer.concat([header, Buffer.alloc(bytes)]));
        const [command] = previewCommands(input, directory, "audio/wav");
        await runPreviewCommand([...command!.args, command!.path], new AbortController().signal);
        expect((await NodeFSP.readFile(command!.path)).subarray(4, 8).toString()).toBe("ftyp");
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("never executes unknown file types and strips metadata from video output", () => {
    expect(() => previewCommands("/tmp/input", "/tmp/output", "application/zip")).toThrow();
    const commands = previewCommands("/tmp/input", "/tmp/output", "video/quicktime");
    expect(commands.map((c) => c.kind)).toEqual(["preview", "poster"]);
    expect(commands[0]!.args).toContain("yuv420p");
    expect(commands[0]!.args).toContain("+faststart");
    expect(commands.every((c) => c.args.includes("-map_metadata"))).toBe(true);
  });
});
