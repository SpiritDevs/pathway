import { afterEach, expect, it, vi } from "vite-plus/test";
import { SimBuildLog, parseSimBuildDiagnostic } from "./SimBuildLog.ts";
afterEach(() => vi.useRealTimers());
it("coalesces short lines and parses split diagnostics without merging stdout and stderr", async () => {
  vi.useFakeTimers();
  const notify = vi.fn();
  const log = new SimBuildLog("/workspace", notify);
  await log.write("A.swift:42:5: warn", "stdout");
  await log.write("other output\n", "stderr");
  await log.write("ing: fix this\n", "stdout");
  expect(notify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).toHaveBeenCalledOnce();
  expect(log.chunks[0]?.diagnostics[0]).toEqual({
    severity: "warning",
    file: "/workspace/A.swift",
    line: 42,
    column: 5,
    message: "fix this",
  });
});
it("bounds chunks, unterminated lines, diagnostics and retained history", async () => {
  const log = new SimBuildLog("/workspace", () => undefined);
  await log.write("x".repeat(200_000), "stdout");
  log.flush(true);
  expect(log.chunks.every((chunk) => chunk.text.length <= 16384)).toBe(true);
  expect(log.chunks.reduce((n, chunk) => n + chunk.text.length, 0)).toBeLessThanOrEqual(65536);
  expect(log.chunks[0]!.sequence).toBeGreaterThan(1);
  expect(parseSimBuildDiagnostic("xcodebuild: error: No scheme", "/workspace")).toMatchObject({
    severity: "error",
    file: null,
    message: "No scheme",
  });
});
it("flushes diagnostics without trailing newline before the terminal receipt", async () => {
  const log = new SimBuildLog("/workspace", () => undefined);
  await log.write("/tmp/a file.swift:3: error: stopped", "stderr");
  log.flush(true);
  expect(log.chunks[0]?.diagnostics[0]).toMatchObject({
    file: "/tmp/a file.swift",
    line: 3,
    column: null,
    severity: "error",
  });
});
