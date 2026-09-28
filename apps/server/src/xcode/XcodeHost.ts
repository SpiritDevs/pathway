// @effect-diagnostics globalDate:off nodeBuiltinImport:off globalFetch:off globalTimers:off -- Host I/O boundary; injected process runner and HTTP transport.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  type AvailableXcode,
  type InstalledXcode,
  type XcodeJob,
  type XcodePlatform,
  type XcodeRuntime,
  type XcodeStatus,
  type XcodeStepId,
  type XcodeStep,
} from "@spiritdevs/contracts/xcode";
import type { AppleIdSession } from "../apple/AppleIdSession.ts";
import { AppleCookieHttp, type AppleHttp } from "../apple/AppleIdProtocol.ts";
import { type XcodeHost, xcodeError } from "./XcodeInstall.ts";
import { runXcodeProcess, type XcodeProcessRunner, type XcodeCommand } from "./XcodeProcess.ts";

const GiB = 1024 ** 3;
const releaseSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    version: Schema.Struct({
      number: Schema.String,
      build: Schema.optional(Schema.String),
      release: Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Number])),
    }),
    links: Schema.optional(
      Schema.Struct({
        download: Schema.optional(
          Schema.Struct({
            url: Schema.String,
            architectures: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      }),
    ),
    checksums: Schema.optional(
      Schema.Struct({
        sha1: Schema.optional(Schema.String),
        sha256: Schema.optional(Schema.String),
      }),
    ),
    requires: Schema.optional(Schema.String),
  }),
);
type Release = AvailableXcode & {
  url: string;
  sha1: string | null;
  sha256: string | null;
  requires: string | null;
  architectures: readonly string[];
};
const installedRuntimeSchema = Schema.Struct({
  runtimes: Schema.Array(
    Schema.Struct({
      identifier: Schema.String,
      name: Schema.String,
      version: Schema.String,
      buildversion: Schema.optional(Schema.String),
      isAvailable: Schema.Boolean,
    }),
  ),
});
const runtimeIndexSchema = Schema.Struct({
  downloadables: Schema.Array(
    Schema.Struct({
      identifier: Schema.String,
      platform: Schema.String,
      fileSize: Schema.Number,
      simulatorVersion: Schema.Struct({ version: Schema.String, buildUpdate: Schema.String }),
      hostRequirements: Schema.optional(
        Schema.Struct({
          minHostVersion: Schema.optional(Schema.String),
          maxHostVersion: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodePlist = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeReleases = Schema.decodeUnknownSync(releaseSchema);
const decodeInstalledRuntimes = Schema.decodeUnknownSync(
  Schema.fromJsonString(installedRuntimeSchema),
);
const decodeRuntimeIndex = Schema.decodeUnknownSync(Schema.fromJsonString(runtimeIndexSchema));
const versionCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const exists = async (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );
const platformFor = (name: string): XcodePlatform | null =>
  /iOS|iphoneos/i.test(name)
    ? "iOS"
    : /watchOS|watchos/i.test(name)
      ? "watchOS"
      : /tvOS|appletvos/i.test(name)
        ? "tvOS"
        : null;

export class MacXcodeHost implements XcodeHost {
  readonly supported: boolean;
  #catalog: { at: number; releases: readonly Release[] } | null = null;
  #catalogPending: Promise<readonly Release[]> | null = null;
  #inspection: { at: number; promise: Promise<Omit<XcodeStatus, "job">> } | null = null;
  readonly root: string;
  readonly sessions: Pick<AppleIdSession, "lease">;
  readonly runProcess: XcodeProcessRunner;
  readonly http: AppleHttp;
  readonly now: () => number;
  readonly applications: string;
  readonly arch: string;
  readonly freeBytes: () => Promise<number>;
  constructor(
    root: string,
    sessions: Pick<AppleIdSession, "lease">,
    options: {
      platform: string;
      arch: string;
      runProcess?: XcodeProcessRunner;
      http?: AppleHttp;
      now?: () => number;
      applications?: string;
      freeBytes?: () => Promise<number>;
    },
  ) {
    const {
      platform,
      arch,
      runProcess = runXcodeProcess,
      http = (url, init) => fetch(url, init),
      now = Date.now,
      applications = "/Applications",
      freeBytes,
    } = options;
    this.root = root;
    this.sessions = sessions;
    this.runProcess = runProcess;
    this.http = http;
    this.now = now;
    this.applications = applications;
    this.arch = arch;
    this.supported = platform === "darwin";
    this.freeBytes =
      freeBytes ??
      (async () => {
        await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
        const [space, target] = await Promise.all([
          NodeFSP.statfs(root),
          NodeFSP.statfs(applications),
        ]);
        return Math.min(space.bavail * space.bsize, target.bavail * target.bsize);
      });
  }
  async #catalogue(): Promise<readonly Release[]> {
    if (this.#catalog && this.now() - this.#catalog.at < 60 * 60_000) return this.#catalog.releases;
    if (this.#catalogPending) return this.#catalogPending;
    this.#catalogPending = (async () => {
      const response = await this.http("https://xcodereleases.com/data.json", {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw xcodeError("download-failed", "Could not load the Xcode release catalogue.");
      const values = decodeReleases(await response.json());
      const releases = values.flatMap((v): Release[] => {
        const download = v.links?.download;
        const build = v.version.build;
        if (
          v.name !== "Xcode" ||
          !download ||
          !build ||
          !/^[a-z0-9.]+$/i.test(build) ||
          !/^[0-9.]+$/.test(v.version.number)
        )
          return [];
        const url = new URL(download.url);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "download.developer.apple.com" ||
          !url.pathname.endsWith(".xip")
        )
          return [];
        const architectures = download.architectures ?? [];
        if (
          architectures.length &&
          !architectures.includes(this.arch === "x64" ? "x86_64" : this.arch)
        )
          return [];
        return [
          {
            id: build,
            version: v.version.number,
            build,
            beta: v.version.release.release !== true,
            downloadBytes: null,
            requiredBytes: 45 * GiB,
            url: url.href,
            sha1: v.checksums?.sha1 ?? null,
            sha256: v.checksums?.sha256 ?? null,
            requires: v.requires ?? null,
            architectures,
          },
        ];
      });
      this.#catalog = { at: this.now(), releases };
      return releases;
    })().finally(() => {
      this.#catalogPending = null;
    });
    return this.#catalogPending;
  }
  async #release(id: string) {
    const release = (await this.#catalogue()).find((r) => r.id === id);
    if (!release)
      throw xcodeError("not-found", "Choose an Xcode build from the available versions.");
    return release;
  }
  async installPath(versionId: string) {
    const v = await this.#release(versionId);
    return NodePath.join(this.applications, `Xcode-${v.version}-${v.build}.app`);
  }
  #command(
    file: string,
    args: readonly string[],
    signal: AbortSignal,
    extra: Omit<XcodeCommand, "file" | "args"> = {},
  ) {
    return this.runProcess({ file, args, ...extra }, signal);
  }
  async #plist(path: string, signal: AbortSignal) {
    return decodePlist(
      await this.#command("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], signal),
    );
  }
  async #installed(signal: AbortSignal): Promise<readonly InstalledXcode[]> {
    const selected = await this.#command("/usr/bin/xcode-select", ["-p"], signal).then(
      (s) => s.trim(),
      () => "",
    );
    const paths = new Set<string>();
    const discovered = await this.#command(
      "/usr/bin/mdfind",
      ["kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"],
      signal,
    ).catch(() => "");
    for (const path of discovered
      .split("\n")
      .filter((p) => p.startsWith("/") && p.endsWith(".app"))
      .slice(0, 256)) {
      if (!path.startsWith(`${this.root}/`)) paths.add(path);
    }
    for (const entry of await NodeFSP.readdir(this.applications, { withFileTypes: true }))
      if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name.endsWith(".app"))
        paths.add(NodePath.join(this.applications, entry.name));
    const selectedApp = selected.endsWith("/Contents/Developer")
      ? selected.slice(0, -"/Contents/Developer".length)
      : null;
    if (selectedApp) paths.add(selectedApp);
    const selectedRealPath = selectedApp
      ? await NodeFSP.realpath(selectedApp).catch(() => selectedApp)
      : null;
    const results: InstalledXcode[] = [];
    for (const path of paths) {
      try {
        const info = await this.#plist(NodePath.join(path, "Contents/Info.plist"), signal);
        if (info.CFBundleIdentifier !== "com.apple.dt.Xcode") continue;
        const version = await this.#plist(NodePath.join(path, "Contents/version.plist"), signal);
        if (
          typeof version.CFBundleShortVersionString !== "string" ||
          typeof version.ProductBuildVersion !== "string"
        )
          continue;
        const resolved = await NodeFSP.realpath(path);
        if (results.some((v) => v.path === resolved)) continue;
        results.push({
          path: resolved,
          version: version.CFBundleShortVersionString,
          build: version.ProductBuildVersion,
          beta:
            /beta|seed|preview/i.test(String(info.CFBundleName)) ||
            /[a-z]$/.test(version.ProductBuildVersion),
          selected: resolved === selectedRealPath,
        });
      } catch {
        /* Other applications and incomplete bundles are not Xcode installs. */
      }
    }
    return results;
  }
  inspect(): Promise<Omit<XcodeStatus, "job">> {
    if (!this.supported)
      return Promise.resolve({
        host: "needs-mac",
        installed: [],
        available: [],
        runtimes: [],
        disk: { freeBytes: null, requiredBytes: 45 * GiB },
        error: { code: "needs-mac", message: "Xcode needs a Mac host." },
      });
    if (this.#inspection && this.now() - this.#inspection.at < 5_000)
      return this.#inspection.promise;
    const promise = this.#inspect();
    this.#inspection = { at: this.now(), promise };
    return promise;
  }
  async #inspect(): Promise<Omit<XcodeStatus, "job">> {
    const signal = AbortSignal.timeout(60_000);
    await NodeFSP.mkdir(this.root, { recursive: true, mode: 0o700 });
    const [installed, freeBytes, catalogue] = await Promise.all([
      this.#installed(signal),
      this.freeBytes(),
      this.#catalogue().then(
        (releases) => ({ releases, error: null }),
        () => ({
          releases: [] as readonly Release[],
          error: {
            code: "download-failed" as const,
            message: "The Xcode release catalogue is unavailable. Retry status to refresh it.",
          },
        }),
      ),
    ]);
    const runtimes: XcodeRuntime[] = [];
    let runtimeError: XcodeStatus["error"] = null;
    const selected = installed.find((x) => x.selected);
    if (selected) {
      try {
        const data = decodeInstalledRuntimes(
          await this.#command("/usr/bin/xcrun", ["simctl", "list", "runtimes", "--json"], signal, {
            env: { DEVELOPER_DIR: `${selected.path}/Contents/Developer` },
          }),
        );
        for (const item of data.runtimes) {
          const platform = platformFor(item.name);
          if (platform)
            runtimes.push({
              id: item.identifier,
              platform,
              version: item.version,
              build: item.buildversion ?? null,
              installed: true,
              available: item.isAvailable,
              downloadBytes: null,
            });
        }
      } catch {
        runtimeError = {
          code: "process-failed",
          message: "Installed runtimes could not be inspected. Complete Xcode first-launch tasks.",
        };
      }
    }
    try {
      const response = await this.http(
        "https://devimages-cdn.apple.com/downloads/xcode/simulators/index2.dvtdownloadableindex",
        { signal },
      );
      if (!response.ok) throw xcodeError("download-failed", "Runtime catalogue unavailable.");
      const data = decodeRuntimeIndex(
        await this.#command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], signal, {
          input: await response.text(),
        }),
      );
      const hostVersion = (
        await this.#command("/usr/bin/sw_vers", ["-productVersion"], signal)
      ).trim();
      for (const item of data.downloadables) {
        const platform = platformFor(item.platform);
        if (!platform) continue;
        const min = item.hostRequirements?.minHostVersion;
        const max = item.hostRequirements?.maxHostVersion;
        if (
          (min && versionCompare(hostVersion, min) < 0) ||
          (max && versionCompare(hostVersion, max) > 0)
        )
          continue;
        const existing = runtimes.find(
          (r) => r.platform === platform && r.build === item.simulatorVersion.buildUpdate,
        );
        if (!existing)
          runtimes.push({
            id: item.identifier,
            platform,
            version: item.simulatorVersion.version,
            build: item.simulatorVersion.buildUpdate,
            installed: false,
            available: true,
            downloadBytes: item.fileSize,
          });
      }
    } catch {
      runtimeError ??= {
        code: "download-failed",
        message: "Available runtimes could not be loaded. Retry status to refresh them.",
      };
    }
    return {
      host: "mac",
      installed,
      available: catalogue.releases.map(
        ({ id, version, build, beta, downloadBytes, requiredBytes }) => ({
          id,
          version,
          build,
          beta,
          downloadBytes,
          requiredBytes,
        }),
      ),
      runtimes,
      disk: { freeBytes, requiredBytes: 45 * GiB },
      error: catalogue.error ?? runtimeError,
    };
  }
  needsAdmin(step: XcodeStepId) {
    return ["move", "license", "select", "first-launch", "helpers"].includes(step);
  }
  async cleanup(job: XcodeJob) {
    await NodeFSP.rm(NodePath.join(this.root, job.id), { recursive: true, force: true });
  }
  async interrupt(job: XcodeJob) {
    const directory = NodePath.join(this.root, job.id);
    for (const name of await NodeFSP.readdir(directory).catch(() => [] as string[])) {
      if (/^admin-[a-f0-9-]+\.allow$/.test(name))
        await NodeFSP.rm(NodePath.join(directory, name), { force: true });
    }
  }
  async #waitForAdmin(lock: string) {
    if (!(await exists(lock))) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        watcher.close();
        reject(
          xcodeError(
            "busy",
            "The previous admin operation is still stopping on the Mac. Retry when it has finished.",
          ),
        );
      }, 15_000);
      const watcher = NodeFS.watch(this.root, () => {
        void exists(lock).then((active) => {
          if (!active) {
            clearTimeout(timer);
            watcher.close();
            resolve();
          }
        });
      });
      watcher.on("error", () => {
        clearTimeout(timer);
        watcher.close();
        reject(xcodeError("process-failed", "Could not observe the admin operation on the Mac."));
      });
      void exists(lock).then((active) => {
        if (!active) {
          clearTimeout(timer);
          watcher.close();
          resolve();
        }
      });
    });
  }
  async #elevated(job: XcodeJob, command: string, signal: AbortSignal, prepare = "", after = "") {
    const directory = NodePath.join(this.root, job.id);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const allow = NodePath.join(directory, `admin-${NodeCrypto.randomUUID()}.allow`);
    const lock = NodePath.join(this.root, "admin.lock");
    await this.#waitForAdmin(lock);
    await NodeFSP.writeFile(allow, "authorized", { mode: 0o600 });
    const requestCancel = () => {
      void NodeFSP.rm(allow, { force: true }).catch(() => undefined);
    };
    signal.addEventListener("abort", requestCancel, { once: true });
    // Each approval has its own revocable marker. A prompt from an interrupted server
    // cannot start later, even after a new attempt has been approved.
    const script = `umask 077\n[ -f ${shellQuote(allow)} ] || exit 130\n/bin/mkdir ${shellQuote(lock)} || exit 75\ntrap ${shellQuote(`/bin/rmdir ${shellQuote(lock)}`)} EXIT\n${prepare}\n${command} &\noperation_pid=$!\n(remaining=1200; while /bin/kill -0 "$operation_pid" 2>/dev/null; do if [ ! -f ${shellQuote(allow)} ] || [ "$remaining" -le 0 ]; then /bin/kill -TERM "$operation_pid"; /bin/sleep 5; /bin/kill -KILL "$operation_pid" 2>/dev/null; exit; fi; remaining=$((remaining - 1)); /bin/sleep 1; done) &\nwatcher_pid=$!\nwait "$operation_pid"\nresult=$?\n/bin/kill "$watcher_pid" 2>/dev/null\n[ -f ${shellQuote(allow)} ] || exit 130\n[ "$result" -eq 0 ] || exit "$result"\n${after}\n`;
    const source = `with timeout of 1500 seconds\n do shell script ${JSON.stringify(script)} with administrator privileges\nend timeout\n`;
    try {
      signal.throwIfAborted();
      await this.#command("/usr/bin/osascript", ["-"], signal, {
        input: source,
        timeoutMs: 1_510_000,
      });
      signal.throwIfAborted();
    } catch (error) {
      await NodeFSP.rm(allow, { force: true });
      await this.#waitForAdmin(lock);
      if (signal.aborted) throw error;
      throw xcodeError(
        "admin-required",
        "Admin approval on the Mac was denied, timed out, or the privileged step failed. Retry to request approval again.",
      );
    } finally {
      signal.removeEventListener("abort", requestCancel);
      await NodeFSP.rm(allow, { force: true });
      this.#inspection = null;
    }
  }
  async #validatePath(path: string, signal: AbortSignal) {
    const resolved = await NodeFSP.realpath(path).catch(() => path);
    if (!(await this.#installed(signal)).some((x) => x.path === resolved))
      throw xcodeError("not-found", "Choose an installed Xcode path from status.");
  }
  async run(
    step: XcodeStepId,
    job: XcodeJob,
    signal: AbortSignal,
    progress: (value: NonNullable<XcodeStep["progress"]>) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!this.supported) throw xcodeError("needs-mac", "Xcode needs a Mac host.");
    const directory = NodePath.join(this.root, job.id);
    const archive = NodePath.join(directory, "Xcode.xip");
    const expanded = NodePath.join(directory, "expanded");
    const developer = NodePath.join(job.path, "Contents/Developer");
    const xcodebuild = NodePath.join(developer, "usr/bin/xcodebuild");
    if (step === "check") {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      await this.#waitForAdmin(NodePath.join(this.root, "admin.lock"));
      const freeBytes = await this.freeBytes();
      const needed =
        (job.kind === "install" ? 45 : job.kind === "runtimes" ? 5 : 0) * GiB +
        job.platforms.length * 15 * GiB;
      if (freeBytes < needed)
        throw xcodeError(
          "disk-space",
          `Xcode needs ${Math.ceil(needed / GiB)} GiB of free space on the Mac. Free space and retry.`,
        );
      if (job.kind === "install") {
        const release = await this.#release(job.versionId!);
        if (job.path !== (await this.installPath(job.versionId!)))
          throw xcodeError("invalid-response", "The Xcode install destination changed.");
        const version = (
          await this.#command("/usr/bin/sw_vers", ["-productVersion"], signal)
        ).trim();
        if (release.requires && versionCompare(version, release.requires) < 0)
          throw xcodeError(
            "process-failed",
            `This Xcode requires macOS ${release.requires} or later on the host.`,
          );
        try {
          await this.sessions.lease(job.account!);
        } catch {
          throw xcodeError(
            "reauth-required",
            "Sign in to the Apple account, then retry the install.",
          );
        }
      } else await this.#validatePath(job.path, signal);
    } else if (step === "download") {
      await this.#download(job, archive, signal, progress);
    } else if (step === "expand") {
      // An interrupted expansion is never considered complete. Only this job's scratch is removed.
      await NodeFSP.rm(expanded, { recursive: true, force: true });
      await NodeFSP.mkdir(expanded, { recursive: true, mode: 0o700 });
      await this.#command("/usr/bin/xip", ["--expand", archive], signal, {
        cwd: expanded,
        timeoutMs: 60 * 60_000,
      });
      const app = (await NodeFSP.readdir(expanded)).find((name) => /^Xcode.*\.app$/.test(name));
      if (!app) throw xcodeError("invalid-response", "The archive did not contain Xcode.");
      const info = await this.#plist(
        NodePath.join(expanded, app, "Contents/version.plist"),
        signal,
      );
      if (info.ProductBuildVersion !== job.versionId)
        throw xcodeError(
          "invalid-response",
          "The expanded Xcode build does not match the selected release.",
        );
      await this.#command(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", NodePath.join(expanded, app)],
        signal,
        { timeoutMs: 10 * 60_000 },
      );
    } else if (step === "move") {
      const resolved = await NodeFSP.realpath(job.path).catch(() => job.path);
      const installed = (await this.#installed(signal)).find((x) => x.path === resolved);
      if (installed?.build === job.versionId) return;
      if (await exists(job.path))
        throw xcodeError(
          "process-failed",
          "The destination already exists and is not the requested Xcode. It was left unchanged.",
        );
      const app = (await NodeFSP.readdir(expanded)).find((name) => /^Xcode.*\.app$/.test(name));
      if (!app)
        throw xcodeError("not-found", "The expanded Xcode is missing. Start a new install.");
      // Copy across volumes into a staging sibling, then rename. A failed copy is never
      // exposed as an installed Xcode and an existing application is never overwritten.
      const stage = `${job.path}.pathway-${job.id}`;
      await this.#elevated(
        job,
        `/usr/bin/ditto ${shellQuote(NodePath.join(expanded, app))} ${shellQuote(stage)}`,
        signal,
        `test ! -e ${shellQuote(job.path)} || exit 1\n/bin/rm -rf ${shellQuote(stage)} || exit 1`,
        `test ! -e ${shellQuote(job.path)} && /bin/mv -n ${shellQuote(stage)} ${shellQuote(job.path)}`,
      );
    } else if (step === "runtimes") {
      await this.#validatePath(job.path, signal);
      for (const platform of job.platforms)
        await this.#command(xcodebuild, ["-downloadPlatform", platform], signal, {
          env: { DEVELOPER_DIR: developer },
          timeoutMs: 2 * 60 * 60_000,
        });
      this.#inspection = null;
    } else {
      await this.#validatePath(job.path, signal);
      const command =
        step === "license"
          ? `${shellQuote(xcodebuild)} -license accept`
          : step === "select"
            ? `/usr/bin/xcode-select --switch ${shellQuote(developer)}`
            : step === "helpers"
              ? `${shellQuote(xcodebuild)} -runFirstLaunch -checkForNewerComponents`
              : `${shellQuote(xcodebuild)} -runFirstLaunch`;
      await this.#elevated(job, command, signal);
    }
  }
  async #download(
    job: XcodeJob,
    archive: string,
    signal: AbortSignal,
    progress: (value: NonNullable<XcodeStep["progress"]>) => void,
  ) {
    const release = await this.#release(job.versionId!);
    const partial = `${archive}.part`;
    let bytes = await NodeFSP.stat(partial).then(
      (s) => s.size,
      () => 0,
    );
    if (await exists(archive)) return;
    const started = this.now();
    const initial = bytes;
    let total: number | null = null;
    let held: {
      client: AppleCookieHttp;
      expiresAt: number;
      revision: number;
      accountRevision: number;
    } | null = null;
    let revision: number | undefined;
    let accountRevision: number | undefined;
    while (total === null || bytes < total) {
      signal.throwIfAborted();
      if (!held || held.expiresAt <= this.now() + 500) {
        const lease = await this.sessions.lease(job.account!).catch(() => {
          throw xcodeError(
            "reauth-required",
            "Sign in to the Apple account, then retry the download.",
          );
        });
        if (
          (revision !== undefined && lease.revision !== revision) ||
          (accountRevision !== undefined && lease.accountRevision !== accountRevision)
        )
          throw xcodeError("reauth-required", "The Apple session changed. Retry the download.");
        revision = lease.revision;
        accountRevision = lease.accountRevision;
        const client = new AppleCookieHttp(this.http, this.now);
        client.restore(lease.credential);
        const auth = await client.request(
          `https://developerservices2.apple.com/services/download?path=${encodeURIComponent(new URL(release.url).pathname)}`,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) },
        );
        await auth.body?.cancel();
        if (!auth.ok)
          throw xcodeError(
            "reauth-required",
            "Apple denied the download. Sign in again and check Developer access.",
          );
        held = { client, expiresAt: lease.leaseExpiresAt, revision, accountRevision };
      }
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, held.expiresAt - this.now())),
      ]);
      const before = bytes;
      try {
        const response = await held.client.request(release.url, {
          signal: requestSignal,
          headers: {
            Range: `bytes=${bytes}-${bytes + 32 * 1024 * 1024 - 1}`,
            "Accept-Encoding": "identity",
          },
        });
        if (
          response.status === 416 &&
          response.headers.get("content-range") === `bytes */${bytes}` &&
          bytes > 0
        ) {
          await response.body?.cancel();
          total = bytes;
          break;
        }
        if (response.status === 401 || response.status === 403)
          throw xcodeError(
            "reauth-required",
            "Apple rejected the download session. Sign in again.",
          );
        if (![200, 206].includes(response.status) || !response.body)
          throw xcodeError("download-failed", "Apple did not return the Xcode archive.");
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") ?? "",
        );
        if (response.status === 206 && (!range || Number(range[1]) !== bytes))
          throw xcodeError("invalid-response", "Apple returned an invalid download range.");
        if (response.status === 200) bytes = 0;
        total = range ? Number(range[3]) : Number(response.headers.get("content-length"));
        if (
          !total ||
          total > 100 * GiB ||
          total <= bytes ||
          /text|json|html/i.test(response.headers.get("content-type") ?? "")
        )
          throw xcodeError(
            "invalid-response",
            "Apple returned an invalid archive size or content type.",
          );
        const file = await NodeFSP.open(partial, bytes === 0 ? "w" : "a", 0o600);
        try {
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            if (bytes + chunk.length > total)
              throw xcodeError("invalid-response", "The archive exceeded the announced size.");
            await file.writeFile(chunk);
            bytes += chunk.length;
            progress({
              bytes,
              total,
              bytesPerSecond:
                Math.max(0, bytes - initial) / Math.max(1, (this.now() - started) / 1000),
            });
          }
          await file.sync();
        } finally {
          await file.close();
        }
        if (bytes === before)
          throw xcodeError("download-failed", "The Xcode download stopped making progress.");
      } catch (error) {
        if (!signal.aborted && requestSignal.aborted && bytes > before) {
          held = null;
          continue;
        }
        throw error;
      }
    }
    if (release.sha256 || release.sha1) {
      const hash = NodeCrypto.createHash(release.sha256 ? "sha256" : "sha1");
      for await (const chunk of NodeFS.createReadStream(partial)) {
        signal.throwIfAborted();
        hash.update(chunk);
      }
      if (hash.digest("hex") !== (release.sha256 ?? release.sha1)) {
        await NodeFSP.rm(partial, { force: true });
        throw xcodeError(
          "download-failed",
          "The Xcode archive checksum did not match. Retry to download it again.",
        );
      }
    }
    await NodeFSP.rename(partial, archive);
  }
}
