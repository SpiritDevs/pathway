import { CompanyId } from "@spiritdevs/contracts/company";
import type { ReleaseJob, ReleaseOrganizer } from "@spiritdevs/contracts/releases";
import { describe, expect, it } from "vite-plus/test";

import {
  applyReleaseUpdate,
  EMPTY_RELEASE_VIEW,
  releaseJobStatus,
  runningReleaseJob,
} from "./releases.ts";

const target = { companyId: CompanyId.make("c"), accountId: "a", teamId: "t", appId: "app" };
const job = (overrides: Partial<ReleaseJob> = {}): ReleaseJob => ({
  id: "job",
  target,
  kind: "archive",
  state: "running",
  phase: "archiving",
  progress: null,
  archiveId: null,
  intentId: null,
  resourceId: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});
const local = { environmentId: "env", environmentLabel: "Studio", archives: [], jobs: [job()] };
const organizer: ReleaseOrganizer = {
  builds: [],
  groups: [],
  testers: [],
  versions: [],
  reviews: [],
  fetchedAt: 5,
};

describe("applyReleaseUpdate", () => {
  it("keeps Apple metadata across local job ticks and vice versa", () => {
    const withOrganizer = applyReleaseUpdate(EMPTY_RELEASE_VIEW, {
      kind: "organizer",
      organizer,
    });
    const ticked = applyReleaseUpdate(withOrganizer, { kind: "local", local });
    expect(ticked).toEqual({ local, organizer });
    const refreshed = applyReleaseUpdate(ticked, {
      kind: "organizer",
      organizer: { ...organizer, fetchedAt: 9 },
    });
    expect(refreshed.local).toBe(local);
    expect(refreshed.organizer?.fetchedAt).toBe(9);
  });
});

describe("releaseJobStatus", () => {
  it("labels known phases and never relabels an unknown one as success", () => {
    expect(releaseJobStatus(job())).toBe("Archiving…");
    expect(releaseJobStatus(job({ phase: "notarizing" }))).toBe("notarizing");
    expect(
      releaseJobStatus(
        job({ kind: "upload", state: "completed", phase: "uploaded-awaiting-processing" }),
      ),
    ).toBe("Uploaded. Apple is processing the build");
  });

  it("shows the safe server message for failures", () => {
    expect(
      releaseJobStatus(
        job({ state: "failed", error: { code: "archive-failed", message: "Signing failed." } }),
      ),
    ).toBe("Signing failed.");
    expect(releaseJobStatus(job({ state: "interrupted" }))).toContain("Interrupted");
  });
});

describe("runningReleaseJob", () => {
  it("finds the one running job", () => {
    expect(runningReleaseJob([job({ id: "a", state: "failed" }), job({ id: "b" })])?.id).toBe("b");
    expect(runningReleaseJob([job({ state: "completed" })])).toBeNull();
  });
});
