// A JSON-lines child for protocol tests. It never loads weights or opens a network connection.
import * as NodeReadline from "node:readline";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
if (process.argv.includes("--fixture-cold")) {
  process.stderr.write("cold\n");
} else emit({ type: "ready", engineVersion: "fixture" });

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const mode = request.path ?? request.text;
  process.stderr.write("received\n");
  if (mode === "echo-language") {
    emit({ type: "result", id: request.id, text: request.language });
    continue;
  }
  if (mode === "hang") continue;
  if (mode === "crash") process.exit(4);
  if (mode === "oversized") {
    process.stdout.write("x".repeat(65537));
    continue;
  }
  if (mode === "malformed") {
    process.stdout.write("{invalid}\n");
    continue;
  }
  if (mode === "wrong-id") {
    emit({ type: "result", id: "previous-turn", text: "stale" });
    continue;
  }
  if (mode === "error") {
    emit({ type: "error", id: request.id, message: "Fixture decode failed." });
    continue;
  }
  emit({ type: "progress", id: request.id, value: 0.5 });
  const output = Buffer.from(
    JSON.stringify({ type: "result", id: request.id, text: "Olá, 世界!" }) + "\n",
  );
  const cut = output.indexOf(Buffer.from("世")) + 1;
  process.stdout.write(output.subarray(0, cut));
  process.stdout.write(output.subarray(cut));
}
