#!/usr/bin/env node
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args.includes("--help")) {
  console.log(
    "node scripts/benchmark-dictation-engines.mjs --speech-model PATH --vad-model PATH --cleanup-model PATH --audio WAV [--engine-directory DIR] [--device auto|cpu|gpu] [--language auto|CODE] [--cleanup-language auto|CODE] [--repeat N]",
  );
  console.log(
    "Uses existing models and audio. Reports phase timings without printing dictated text.",
  );
  process.exit(0);
}
const required = (name) => {
  const value = option(name);
  NodeAssert.ok(value && !value.startsWith("--"), `${name} is required`);
  return value;
};
const speechModel = required("--speech-model");
const vadModel = required("--vad-model");
const cleanupModel = required("--cleanup-model");
const audio = required("--audio");
const repeat = Number(option("--repeat") ?? "3");
NodeAssert.ok(Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= 20);
const directory = option("--engine-directory") ?? "native/dictation/build/engines";
const device = option("--device") ?? "auto";
const workers = [];

async function start(kind, model) {
  const started = performance.now();
  const child = NodeChildProcess.spawn(
    NodePath.join(
      directory,
      `pathway-${kind}-engine${HostProcessPlatform.defaultValue() === "win32" ? ".exe" : ""}`,
    ),
    [
      "--model",
      model,
      "--device",
      device,
      "--parent-pid",
      String(process.pid),
      ...(kind === "speech" ? ["--vad-model", vadModel] : []),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  workers.push({ child, closed });
  // Upstream diagnostics can contain tokens; benchmark output includes timings only.
  child.stderr.resume();
  const lines = NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let failure;
  child.once("error", (error) => {
    failure = error;
  });
  const receive = async () => {
    const line = await lines.next();
    if (failure) throw failure;
    NodeAssert.ok(!line.done, `${kind} exited before responding`);
    const event = JSON.parse(line.value);
    if (event.type === "error") throw new Error(event.message);
    return event;
  };
  NodeAssert.equal((await receive()).type, "ready");
  const loadMs = Math.round(performance.now() - started);
  let sequence = 0;
  return {
    loadMs,
    async request(payload) {
      const id = String(++sequence);
      child.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
      while (true) {
        const event = await receive();
        NodeAssert.equal(event.id, id);
        if (event.type === "result") return event;
        NodeAssert.equal(event.type, "progress");
      }
    },
  };
}

// A stalled benchmark must release only the processes it created.
const deadline = setTimeout(
  () => {
    for (const { child } of workers) child.kill("SIGKILL");
  },
  10 * 60 * 1000,
);
try {
  const speech = await start("speech", speechModel);
  let cleanup;
  for (let iteration = 0; iteration < repeat; iteration++) {
    const started = performance.now();
    const transcript = await speech.request({
      type: "transcribe",
      path: audio,
      language: option("--language") ?? "auto",
      prompt: "",
    });
    NodeAssert.ok(transcript.text.trim(), "The recording produced no speech");
    const transcribeMs = Math.round(performance.now() - started);
    cleanup ??= await start("cleanup", cleanupModel);
    const correctionStarted = performance.now();
    await cleanup.request({
      type: "correct",
      text: transcript.text,
      terms: [],
      language: option("--cleanup-language") ?? transcript.language ?? "auto",
    });
    const cleanupMs = Math.round(performance.now() - correctionStarted);
    console.log(
      JSON.stringify({
        iteration,
        device,
        audioSeconds: transcript.duration,
        speechLoadMs: iteration === 0 ? speech.loadMs : 0,
        cleanupLoadMs: iteration === 0 ? cleanup.loadMs : 0,
        transcribeMs,
        cleanupMs,
        totalMs: transcribeMs + cleanupMs + (iteration === 0 ? speech.loadMs + cleanup.loadMs : 0),
      }),
    );
  }
} finally {
  clearTimeout(deadline);
  for (const { child } of workers) child.kill("SIGKILL");
  await Promise.all(workers.map(({ closed }) => closed));
}
