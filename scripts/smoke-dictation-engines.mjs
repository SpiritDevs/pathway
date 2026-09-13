#!/usr/bin/env node
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { DictationInference } from "../apps/desktop/src/dictation/DictationInference.ts";
import { runCleanupQualityChecks } from "../native/dictation/engines/tests/cleanup-quality.mjs";
import { DictationModels } from "../apps/desktop/src/dictation/DictationModels.ts";

const hostPlatform = HostProcessPlatform.defaultValue();
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const engineDirectory = NodePath.join(root, "native/dictation/build/engines");
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args.includes("--help")) {
  console.log(
    "node scripts/smoke-dictation-engines.mjs [--model-directory DIR --audio JFK.wav] [--device auto|cpu|gpu] [--repeat N]",
  );
  console.log(
    "No downloads. Optional inference uses previously verified Base/Qwen models in DIR. Requires Node 22.18+.",
  );
  process.exit(0);
}
for (const kind of ["speech", "cleanup"]) {
  const executable = NodePath.join(
    engineDirectory,
    `pathway-${kind}-engine${hostPlatform === "win32" ? ".exe" : ""}`,
  );
  const help = NodeChildProcess.spawnSync(executable, ["--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  NodeAssert.equal(help.status, 0, help.error?.message ?? help.stderr);
  NodeAssert.equal(help.stdout, "");
  const invalid = NodeChildProcess.spawnSync(
    executable,
    [
      "--model",
      NodePath.join(engineDirectory, "missing-model"),
      "--device",
      "cpu",
      "--parent-pid",
      String(process.pid),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  NodeAssert.notEqual(invalid.status, 0);
  NodeAssert.equal(JSON.parse(invalid.stdout).type, "error");
  console.log(`${kind}: help and missing-model protocol passed`);
}

const directory = option("--model-directory");
if (directory) {
  const models = new DictationModels({ directory, onChange: () => {} });
  const inference = new DictationInference({
    engineDirectory,
    modelDirectory: directory,
    device: option("--device") ?? "auto",
  });
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-native-smoke-"));
  try {
    await models.initialize();
    NodeAssert.ok(
      models.isInstalled("whisper-base"),
      "Install verified Base and Silero models explicitly before this smoke test.",
    );
    NodeAssert.ok(
      models.isInstalled("qwen-cleanup"),
      "Install the verified Qwen model explicitly before the strict inference smoke test.",
    );
    const audioPath = option("--audio");
    if (audioPath) {
      for (const label of ["cold", "warm"]) {
        const started = performance.now();
        const text = await inference.transcribe({
          audioPath,
          modelId: "whisper-base",
          language: "en",
          terms: [],
        });
        NodeAssert.match(text.toLowerCase(), /ask not what your country can do for you/);
        console.log(
          `speech ${label}: ${Math.round(performance.now() - started)} ms; ${JSON.stringify(text)}`,
        );
      }
    }
    const writeSilence = async (seconds) => {
      const samples = Math.round(16000 * seconds);
      const wav = Buffer.alloc(44 + samples * 2);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(samples * 2, 40);
      const filename = NodePath.join(temporary, `silêncio-世界-${seconds}.wav`);
      await NodeFSP.writeFile(filename, wav);
      return filename;
    };
    NodeAssert.equal(
      await inference.transcribe({
        audioPath: await writeSilence(300),
        modelId: "whisper-base",
        language: "auto",
        terms: [],
      }),
      "",
    );
    await NodeAssert.rejects(
      inference.transcribe({
        audioPath: await writeSilence(300.1),
        modelId: "whisper-base",
        language: "auto",
        terms: [],
      }),
      /5 minutes/,
    );
    console.log("speech: five-minute silence, Unicode path, and duration bound passed");
    await runCleanupQualityChecks(inference, Number(option("--repeat") ?? "1"));
    NodeAssert.ok(inference.warmed);
    await inference.unload();
    NodeAssert.equal(inference.warmed, false);
  } finally {
    await inference.dispose();
    await models.dispose();
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
