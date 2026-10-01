import type { LocalReleaseArchive, ReleaseOrganizer } from "@spiritdevs/contracts/releases";
import { describe, expect, it } from "vite-plus/test";

import {
  archiveDraftProblem,
  describeReleaseAction,
  describeReleaseFailure,
  EMPTY_ARCHIVE_DRAFT,
  formatAscState,
  paginate,
  parseReleasesSearch,
  processedBuilds,
  resolveArchiveProjectPath,
} from "./Releases.logic";

const organizer: ReleaseOrganizer = {
  builds: [
    {
      id: "b1",
      version: "1.2",
      buildNumber: "7",
      processingState: "VALID",
      expiresAt: null,
      uploadedDate: null,
      betaReviewState: null,
      internalBuildState: null,
      externalBuildState: null,
    },
    {
      id: "b2",
      version: "1.2",
      buildNumber: "8",
      processingState: "PROCESSING",
      expiresAt: null,
      uploadedDate: null,
      betaReviewState: null,
      internalBuildState: null,
      externalBuildState: null,
    },
  ],
  groups: [{ id: "g1", name: "Staff", isInternalGroup: true }],
  testers: [],
  versions: [
    { id: "v1", version: "1.2", platform: "IOS", state: "PREPARE_FOR_SUBMISSION", buildId: null },
  ],
  reviews: [],
  fetchedAt: 0,
};

describe("parseReleasesSearch", () => {
  it("keeps a project key and only the organizer tab", () => {
    expect(parseReleasesSearch({ project: "p", tab: "organizer", intent: "i1" })).toEqual({
      project: "p",
      tab: "organizer",
      intent: "i1",
    });
    expect(parseReleasesSearch({ project: " ", tab: "other", intent: 3 })).toEqual({
      project: undefined,
      tab: undefined,
      intent: undefined,
    });
  });
});

describe("archive draft", () => {
  it("explains each missing or malformed field", () => {
    expect(archiveDraftProblem(EMPTY_ARCHIVE_DRAFT)).toContain(".xcodeproj");
    const draft = { ...EMPTY_ARCHIVE_DRAFT, projectFile: "App.xcodeproj" };
    expect(archiveDraftProblem(draft)).toContain("scheme");
    expect(archiveDraftProblem({ ...draft, scheme: "App", version: "v1" })).toContain("numeric");
    expect(archiveDraftProblem({ ...draft, scheme: "App", version: "1.2.3" })).toBeNull();
    expect(archiveDraftProblem({ ...draft, projectFile: "App.swift" })).toContain("Choose");
  });

  it("joins relative paths onto the checkout and keeps absolute ones", () => {
    expect(resolveArchiveProjectPath("/src/app/", "./ios/App.xcworkspace/")).toBe(
      "/src/app/ios/App.xcworkspace",
    );
    expect(resolveArchiveProjectPath("/src/app", "/elsewhere/App.xcodeproj")).toBe(
      "/elsewhere/App.xcodeproj",
    );
  });
});

describe("describeReleaseAction", () => {
  it("names builds, groups and the What to test text", () => {
    const summary = describeReleaseAction(
      {
        kind: "testflight",
        buildId: "b1",
        groupIds: ["g1", "gone"],
        locale: "en-US",
        whatsNew: "Try the new tab",
        submitForReview: true,
      },
      { organizer, archives: [] },
    );
    expect(summary.confirmLabel).toBe("Confirm and submit");
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        { label: "Build", value: "1.2 (7)" },
        { label: "Groups", value: "Staff, gone" },
        { label: "What to test", value: "Try the new tab" },
        { label: "Beta review", value: "Submit" },
      ]),
    );
  });

  it("shows the archive and checksum for an upload", () => {
    const archive = {
      id: "a1",
      bundleId: "com.example.app",
      scheme: "App",
      artifactBytes: 5 * 1024 * 1024,
    } as LocalReleaseArchive;
    const summary = describeReleaseAction(
      {
        kind: "upload",
        archiveId: "a1",
        artifactSha256: "abc",
        version: "1.2",
        buildNumber: "9",
        platform: "IOS",
      },
      { organizer: null, archives: [archive] },
    );
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        { label: "Version", value: "1.2 (9)" },
        { label: "Bundle ID", value: "com.example.app" },
        { label: "Size", value: "5.0 MB" },
        { label: "SHA-256", value: "abc" },
      ]),
    );
  });

  it("falls back to IDs for an unknown App Store version", () => {
    const summary = describeReleaseAction(
      { kind: "app-store", buildId: "b9", versionId: "v9" },
      { organizer, archives: [] },
    );
    expect(summary.rows).toEqual([
      { label: "Build", value: "b9" },
      { label: "App Store version", value: "v9" },
    ]);
  });
});

describe("organizer helpers", () => {
  it("offers only processed builds", () => {
    expect(processedBuilds(organizer).map((build) => build.id)).toEqual(["b1"]);
  });

  it("clamps pages after the list shrinks", () => {
    expect(paginate([1, 2, 3, 4, 5], 1, 2)).toEqual({ items: [3, 4], page: 1, pageCount: 3 });
    expect(paginate([1], 4, 2)).toEqual({ items: [1], page: 0, pageCount: 1 });
  });

  it("formats Apple states without inventing labels", () => {
    expect(formatAscState("WAITING_FOR_REVIEW")).toBe("Waiting for review");
    expect(formatAscState(null)).toBe("—");
  });
});

describe("describeReleaseFailure", () => {
  it("reads tagged and Convex errors and hides anything else", () => {
    expect(describeReleaseFailure({ _tag: "ReleaseError", message: "Busy." }, "x")).toBe("Busy.");
    expect(describeReleaseFailure({ data: { message: "Off." } }, "x")).toBe("Off.");
    expect(describeReleaseFailure(new Error("secret"), "x")).toBe("x");
  });
});
