import type { XcodeJob, XcodeStatus, XcodeStep } from "@spiritdevs/contracts/xcode";
import { describe, expect, it } from "vite-plus/test";

import {
  applyXcodeUpdate,
  canCancelXcodeJob,
  canRetryXcodeJob,
  describeXcodeDownload,
  diskShortfall,
  EMPTY_XCODE_VIEW,
  formatXcodeBytes,
  formatXcodeEta,
  isXcodeJobActive,
  orderAvailableXcodes,
  summarizeXcodeJob,
  usableXcode,
  xcodeInstallRequiredBytes,
  xcodeJobTitle,
} from "./xcodeSetup.ts";

const GiB = 1024 ** 3;
const account = { companyId: "company-1", accountId: "account-1" } as XcodeJob["account"];

const step = (
  id: XcodeStep["id"],
  state: XcodeStep["state"],
  progress: XcodeStep["progress"] = null,
) => ({ id, state, error: null, progress }) as XcodeStep;

const job = (overrides: Partial<XcodeJob> = {}): XcodeJob => ({
  id: "job-1",
  kind: "install",
  account,
  versionId: "17B55",
  path: "/Applications/Xcode-26.1.app",
  platforms: ["iOS"],
  state: "running",
  steps: [
    step("check", "completed"),
    step("download", "running", {
      bytes: 5 * GiB,
      total: 10 * GiB,
      bytesPerSecond: 50 * 1024 ** 2,
    }),
    step("expand", "pending"),
    step("move", "pending"),
    step("license", "pending"),
    step("select", "pending"),
    step("first-launch", "pending"),
    step("runtimes", "pending"),
    step("helpers", "skipped"),
  ],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const status = (overrides: Partial<XcodeStatus> = {}): XcodeStatus => ({
  host: "mac",
  installed: [],
  available: [
    {
      id: "17B55",
      version: "26.1",
      build: "17B55",
      beta: false,
      downloadBytes: null,
      requiredBytes: 45 * GiB,
    },
  ],
  runtimes: [],
  disk: { freeBytes: 100 * GiB, requiredBytes: 45 * GiB },
  job: null,
  error: null,
  ...overrides,
});

describe("applyXcodeUpdate", () => {
  it("keeps the last inventory across job ticks and takes the job from a status", () => {
    const withStatus = applyXcodeUpdate(EMPTY_XCODE_VIEW, {
      kind: "status",
      status: status({ job: job({ state: "completed" }) }),
    });
    expect(withStatus.job?.state).toBe("completed");
    const ticked = applyXcodeUpdate(withStatus, { kind: "job", job: job() });
    expect(ticked.status).toBe(withStatus.status);
    expect(ticked.job?.state).toBe("running");
    expect(applyXcodeUpdate(ticked, { kind: "job", job: null }).job).toBeNull();
  });
});

describe("job controls", () => {
  it("follows the host's active, retry and cancel rules", () => {
    expect(isXcodeJobActive(job({ state: "needs-reauth" }))).toBe(true);
    expect(isXcodeJobActive(job({ state: "failed" }))).toBe(false);
    expect(isXcodeJobActive(null)).toBe(false);
    expect(canRetryXcodeJob(job({ state: "interrupted" }))).toBe(true);
    expect(canRetryXcodeJob(job({ state: "running" }))).toBe(false);
    expect(canCancelXcodeJob(job({ state: "needs-admin" }))).toBe(true);
    expect(canCancelXcodeJob(job({ state: "cancelling" }))).toBe(false);
    expect(canCancelXcodeJob(job({ state: "completed" }))).toBe(false);
  });
});

describe("usableXcode", () => {
  it("needs a selected Xcode, not merely an installed one", () => {
    const installed = {
      path: "/Applications/Xcode.app",
      version: "26.1",
      build: "17B55",
      beta: false,
    };
    expect(usableXcode(status({ installed: [{ ...installed, selected: false }] }))).toBeNull();
    expect(usableXcode(status({ installed: [{ ...installed, selected: true }] }))?.path).toBe(
      "/Applications/Xcode.app",
    );
  });
});

describe("orderAvailableXcodes", () => {
  it("recommends the newest release ahead of betas and older versions", () => {
    const entry = (version: string, beta: boolean) => ({
      id: version,
      version,
      build: version,
      beta,
      downloadBytes: null,
      requiredBytes: 45 * GiB,
    });
    const { recommended, ordered } = orderAvailableXcodes([
      entry("26.0.1", false),
      entry("27.0", true),
      entry("26.1", false),
      entry("9.4", false),
    ]);
    expect(recommended?.version).toBe("26.1");
    expect(ordered.map((xcode) => xcode.version)).toEqual(["26.1", "26.0.1", "9.4", "27.0"]);
    expect(orderAvailableXcodes([entry("27.0", true)]).recommended).toBeNull();
  });
});

describe("disk budget", () => {
  it("adds 15 GiB per platform and reports only a real shortfall", () => {
    expect(xcodeInstallRequiredBytes({ requiredBytes: 45 * GiB }, ["iOS", "watchOS"])).toBe(
      75 * GiB,
    );
    expect(diskShortfall(75 * GiB, 70 * GiB)).toBe(5 * GiB);
    expect(diskShortfall(75 * GiB, 80 * GiB)).toBeNull();
    expect(diskShortfall(75 * GiB, null)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats bytes and ETA", () => {
    expect(formatXcodeBytes(512)).toBe("512 B");
    expect(formatXcodeBytes(50 * 1024 ** 2)).toBe("50 MB");
    expect(formatXcodeBytes(3.25 * GiB)).toBe("3.3 GB");
    expect(formatXcodeBytes(120 * GiB)).toBe("120 GB");
    expect(formatXcodeEta(30)).toBe("less than a minute left");
    expect(formatXcodeEta(6 * 60)).toBe("about 6 min left");
    expect(formatXcodeEta(72 * 60)).toBe("about 1 h 12 min left");
    expect(formatXcodeEta(120 * 60)).toBe("about 2 h left");
  });

  it("describes a download with and without a known size", () => {
    expect(
      describeXcodeDownload({ bytes: 5 * GiB, total: 10 * GiB, bytesPerSecond: 50 * 1024 ** 2 }),
    ).toEqual({
      fraction: 0.5,
      amount: "5.0 GB of 10.0 GB",
      speed: "50 MB/s",
      eta: "about 2 min left",
    });
    expect(describeXcodeDownload({ bytes: 5 * GiB, total: null, bytesPerSecond: 0 })).toEqual({
      fraction: null,
      amount: "5.0 GB",
      speed: null,
      eta: null,
    });
  });
});

describe("summarizeXcodeJob", () => {
  it("drops skipped steps and counts a running download by its bytes", () => {
    const summary = summarizeXcodeJob(job());
    expect(summary.total).toBe(8);
    expect(summary.completed).toBe(1);
    expect(summary.current?.id).toBe("download");
    expect(summary.current?.label).toBe("Download Xcode");
    expect(summary.fraction).toBeCloseTo(1.5 / 8);
  });

  it("points at the step waiting for admin approval", () => {
    const summary = summarizeXcodeJob(
      job({
        state: "needs-admin",
        steps: [
          step("check", "completed"),
          step("move", "needs-admin"),
          step("license", "pending"),
        ],
      }),
    );
    expect(summary.current?.id).toBe("move");
  });

  it("has no current step once everything settled", () => {
    const summary = summarizeXcodeJob(
      job({ state: "completed", steps: [step("check", "completed"), step("select", "completed")] }),
    );
    expect(summary.current).toBeNull();
    expect(summary.fraction).toBe(1);
  });
});

describe("xcodeJobTitle", () => {
  it("names the version from the catalogue or the installed app", () => {
    expect(xcodeJobTitle(job(), status())).toBe("Installing Xcode 26.1");
    expect(
      xcodeJobTitle(
        job({
          kind: "select",
          versionId: null,
          path: "/Applications/Xcode-beta.app",
          state: "completed",
        }),
        null,
      ),
    ).toBe("Selected Xcode-beta");
    expect(
      xcodeJobTitle(
        job({ kind: "runtimes", versionId: null, platforms: ["iOS", "tvOS"] }),
        status(),
      ),
    ).toBe("Adding iOS, tvOS to Xcode-26.1");
  });
});
