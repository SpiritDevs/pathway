// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Scratch files and injected host tools/HTTP; never invokes Apple or Xcode.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CompanyId } from "@spiritdevs/contracts/company";
import type { XcodeJob } from "@spiritdevs/contracts/xcode";
import { MacXcodeHost } from "./XcodeHost.ts";
import { fileXcodeJobStore } from "./XcodeJobStore.ts";
import type { XcodeCommand } from "./XcodeProcess.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const account = {
  accountId: "apple",
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
};
const archive = Buffer.from("FAKE-XIP-ARCHIVE");
const catalogue = [
  {
    name: "Xcode",
    version: { number: "27.1", build: "27A1", release: { beta: 1 } },
    requires: "27.0",
    links: {
      download: {
        url: "https://download.developer.apple.com/Developer_Tools/Xcode_27_beta/Xcode_27_beta.xip",
      },
    },
    checksums: { sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex") },
  },
];
async function harness() {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-xcode-test-")),
  );
  roots.push(root);
  const applications = NodePath.join(root, "Applications");
  await NodeFSP.mkdir(applications);
  const path = NodePath.join(applications, "Xcode-27.1-27A1.app");
  const commands: XcodeCommand[] = [];
  const requests: { url: string; headers: Headers }[] = [];
  const lease = vi.fn(async () => ({
    email: "owner@apple.test",
    accountRevision: 1,
    revision: 1,
    expiresAt: Date.now() + 60_000,
    leaseExpiresAt: Date.now() + 30_000,
    credential: {
      cookies: [
        {
          key: "myacinfo",
          value: "SECRET-COOKIE",
          domain: ".apple.com",
          path: "/",
          secure: true,
          httpOnly: true,
          expires: null,
        },
      ],
    },
  }));
  let disk = 200 * 1024 ** 3;
  const host = new MacXcodeHost(
    NodePath.join(root, "state"),
    { lease },
    {
      runProcess: async (command) => {
        commands.push(command);
        if (command.file === "/usr/bin/xcode-select") return `${path}/Contents/Developer\n`;
        if (command.file === "/usr/bin/mdfind") return "";
        if (command.file === "/usr/bin/sw_vers") return "27.0";
        if (command.file === "/usr/bin/plutil") {
          if (command.input)
            return JSON.stringify({
              downloadables: [
                {
                  identifier: "ios27",
                  platform: "com.apple.platform.iphoneos",
                  fileSize: 100,
                  simulatorVersion: { version: "27.0", buildUpdate: "A1" },
                },
              ],
            });
          return command.args.at(-1)?.endsWith("Info.plist")
            ? JSON.stringify({
                CFBundleIdentifier: "com.apple.dt.Xcode",
                CFBundleName: "Xcode-beta",
              })
            : JSON.stringify({ CFBundleShortVersionString: "27.1", ProductBuildVersion: "27A1" });
        }
        if (command.file === "/usr/bin/xcrun") return JSON.stringify({ runtimes: [] });
        return "";
      },
      http: async (url, init) => {
        const headers = new Headers(init.headers);
        requests.push({ url, headers });
        if (url.includes("xcodereleases.com")) return Response.json(catalogue);
        if (url.includes("dvtdownloadableindex")) return new Response("fake-plist");
        if (url.includes("developerservices2")) return new Response("ok");
        if (url.endsWith(".xip")) {
          const start = Number(/^bytes=(\d+)-/.exec(headers.get("range") ?? "")?.[1] ?? 0);
          if (start === archive.length)
            return new Response(null, {
              status: 416,
              headers: { "content-range": `bytes */${archive.length}` },
            });
          return new Response(archive.subarray(start), {
            status: 206,
            headers: {
              "content-range": `bytes ${start}-${archive.length - 1}/${archive.length}`,
              "content-type": "application/octet-stream",
            },
          });
        }
        throw new Error("Unexpected HTTP request");
      },
      platform: "darwin",
      arch: "arm64",
      applications,
      freeBytes: async () => disk,
    },
  );
  const job: XcodeJob = {
    id: "job",
    kind: "install",
    account,
    versionId: "27A1",
    path,
    platforms: ["iOS", "watchOS", "tvOS"],
    state: "running",
    steps: [],
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    host,
    root,
    path,
    job,
    commands,
    requests,
    lease,
    disk: (value: number) => {
      disk = value;
    },
  };
}
describe("Mac Xcode host boundary", () => {
  it("discovers Xcode 27 betas, selected installs and runtime catalogues without Simulator.app", async () => {
    const h = await harness();
    await NodeFSP.mkdir(h.path);
    const status = await h.host.inspect();
    expect(status.installed).toEqual([
      { path: h.path, version: "27.1", build: "27A1", beta: true, selected: true },
    ]);
    expect(status.available[0]).toMatchObject({ id: "27A1", beta: true });
    expect(status.runtimes[0]).toMatchObject({
      platform: "iOS",
      installed: false,
      available: true,
    });
    await h.host.run("runtimes", h.job, new AbortController().signal, () => undefined);
    expect(h.commands.filter((c) => c.file.endsWith("/xcodebuild")).map((c) => c.args)).toEqual([
      ["-downloadPlatform", "iOS"],
      ["-downloadPlatform", "watchOS"],
      ["-downloadPlatform", "tvOS"],
    ]);
    expect(JSON.stringify(h.commands)).not.toContain("Simulator.app");
  });
  it("checks real driver disk requirements before requesting credentials or download", async () => {
    const h = await harness();
    h.disk(10);
    await expect(
      h.host.run("check", h.job, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ code: "disk-space" });
    expect(h.lease).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
  });
  it("resumes a partial HTTP download and verifies the complete archive checksum", async () => {
    const h = await harness();
    const directory = NodePath.join(h.root, "state", h.job.id);
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "Xcode.xip.part"), archive.subarray(0, 4));
    const progress: unknown[] = [];
    await h.host.run("download", h.job, new AbortController().signal, (p) => progress.push(p));
    expect(await NodeFSP.readFile(NodePath.join(directory, "Xcode.xip"))).toEqual(archive);
    expect(
      h.requests
        .find((r) => new URL(r.url).hostname === "download.developer.apple.com")
        ?.headers.get("range"),
    ).toMatch(/^bytes=4-/);
    expect(progress.at(-1)).toMatchObject({ bytes: archive.length, total: archive.length });
    expect(JSON.stringify(h.commands)).not.toContain("SECRET-COOKIE");
  });
  it("recovers an already-complete partial file after a crash before rename", async () => {
    const h = await harness();
    const directory = NodePath.join(h.root, "state", h.job.id);
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "Xcode.xip.part"), archive);
    await h.host.run("download", h.job, new AbortController().signal, () => undefined);
    expect(await NodeFSP.readFile(NodePath.join(directory, "Xcode.xip"))).toEqual(archive);
  });
  it("revokes old admin approval markers after restart and never passes Apple secrets to host tools", async () => {
    const h = await harness();
    await NodeFSP.mkdir(h.path);
    const directory = NodePath.join(h.root, "state", "job");
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "admin-a1b2.allow"), "authorized");
    await h.host.interrupt(h.job);
    await expect(
      NodeFSP.readFile(NodePath.join(directory, "admin-a1b2.allow")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await h.host.run("helpers", h.job, new AbortController().signal, () => undefined);
    const command = h.commands.find((c) => c.file.endsWith("osascript"));
    expect(command?.input).toContain("with administrator privileges");
    expect(command?.input).toContain("-runFirstLaunch -checkForNewerComponents");
    expect(command?.input).toContain("operation_pid=$!");
    expect(command?.input).not.toContain("SECRET-COOKIE");
  });
  it("non-Mac status does not invoke processes, fetch metadata or touch the job directory", async () => {
    const run = vi.fn();
    const http = vi.fn();
    const host = new MacXcodeHost(
      "/does-not-exist",
      { lease: vi.fn() },
      { runProcess: run, http, platform: "linux", arch: "x64" },
    );
    expect(await host.inspect()).toMatchObject({ host: "needs-mac", error: { code: "needs-mac" } });
    expect(run).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });
  it("atomically stores a secret-free job and refuses corrupt recovery data", async () => {
    const h = await harness();
    const path = NodePath.join(h.root, "job.json");
    const store = fileXcodeJobStore(path);
    expect(await store.load()).toBeNull();
    await store.save(h.job);
    expect(await store.load()).toEqual(h.job);
    await NodeFSP.writeFile(path, "corrupt");
    await expect(store.load()).rejects.toMatchObject({ code: "storage-failed" });
  });
});
