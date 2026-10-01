import * as NodeVM from "node:vm";
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { tvInputBuildSource } from "./tvInputBuild.ts";

function fixture(exists = false, compiler = true) {
  const writes = new Map<string, string>();
  const fs = {
    access: vi.fn(async () => {
      if (!exists) throw Error("missing");
    }),
    readFile: vi.fn(async () => Buffer.from("reviewed-source-or-binary")),
    rename: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, value: string) => {
      writes.set(path, value);
    }),
    rm: vi.fn(async () => {}),
  };
  const execFile = vi.fn(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string) => void,
    ) => callback(compiler ? null : Error("no clang"), "toolchain"),
  );
  const context = NodeVM.createContext({
    fs,
    execFile,
    createHash: NodeCrypto.createHash,
    fileURLToPath: String,
    URL,
    process: { pid: 100, arch: "arm64", env: {} },
  });
  const build = NodeVM.runInContext(
    tvInputBuildSource
      .replace(/^import.*\n/gm, "")
      .replaceAll("export ", "")
      .replaceAll("import.meta.url", '"file:///hub/pathway-tv-build.mjs"') +
      "\nensurePathwayTvInput",
    context,
  ) as () => Promise<void>;
  return { build, writes, execFile, fs };
}
it("does not invoke Apple tools when a TV executable is already built", async () => {
  const f = fixture(true);
  await f.build();
  expect(f.execFile).not.toHaveBeenCalled();
});
it("builds once on demand and records source, binary and toolchain inputs", async () => {
  const f = fixture();
  await Promise.all([f.build(), f.build()]);
  expect(f.execFile).toHaveBeenCalledTimes(3);
  expect(f.fs.rename).toHaveBeenCalledOnce();
  expect(JSON.parse([...f.writes.values()][0]!)).toMatchObject({
    status: "ready",
    arch: "arm64",
    compiler: "toolchain",
    developerDir: "toolchain",
    sourceSha256: expect.any(String),
    binarySha256: expect.any(String),
  });
});
it("reports compiler unavailability for TV only and leaves no completed executable", async () => {
  const f = fixture(false, false);
  await expect(f.build()).rejects.toThrow("TV input requires a working Xcode compiler");
  expect(f.fs.rename).not.toHaveBeenCalled();
  expect(JSON.parse([...f.writes.values()][0]!)).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("no clang"),
  });
  await expect(f.build()).rejects.toThrow("no clang");
  expect(f.execFile).toHaveBeenCalledTimes(2);
});
