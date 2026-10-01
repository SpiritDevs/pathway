// @effect-diagnostics globalDate:off -- Injected clock; all Apple HTTP is mocked.
import { describe, expect, it, vi } from "vite-plus/test";
import { AppStoreReleaseClient } from "./appStoreReleaseApi.ts";
import type { AscHttp } from "./appStoreConnectApi.ts";
import { appleTestCredential } from "./fixtures/appleTestKey.ts";
const action = {
  kind: "upload" as const,
  archiveId: "archive",
  artifactSha256: "abc",
  version: "1.2",
  buildNumber: "8",
  platform: "IOS" as const,
};
const source = {
  name: "App.ipa",
  size: 6,
  slice: (offset: number, length: number) => new Blob(["abcdef".slice(offset, offset + length)]),
};
const json = (data: unknown) => Response.json(data);
const ref = (type: string, id: string) => ({ data: { type, id } });
const linksOnly = { links: { related: "https://api.appstoreconnect.apple.com/v1/apps/app" } };
const build = {
  type: "builds",
  id: "build",
  attributes: { version: "8", processingState: "VALID" },
  relationships: {
    app: linksOnly,
    preReleaseVersion: ref("preReleaseVersions", "version"),
    betaAppReviewSubmission: ref("betaAppReviewSubmissions", "beta"),
    buildBetaDetail: ref("buildBetaDetails", "detail"),
  },
};
const buildPage = {
  data: [build],
  included: [
    {
      type: "preReleaseVersions",
      id: "version",
      attributes: { version: "1.2" },
      relationships: { builds: linksOnly },
    },
    { type: "betaAppReviewSubmissions", id: "beta", attributes: { betaReviewState: "IN_REVIEW" } },
    {
      type: "buildBetaDetails",
      id: "detail",
      attributes: {
        internalBuildState: "IN_BETA_TESTING",
        externalBuildState: "WAITING_FOR_BETA_REVIEW",
      },
    },
  ],
};
const groups = {
  data: [
    { id: "group", type: "betaGroups", attributes: { name: "External", isInternalGroup: false } },
  ],
};
const versionPage = {
  data: [
    {
      id: "store-version",
      type: "appStoreVersions",
      attributes: {
        versionString: "1.2",
        platform: "IOS",
        appStoreState: "PREPARE_FOR_SUBMISSION",
      },
      relationships: { build: ref("builds", "build"), app: linksOnly },
    },
  ],
};
describe("App Store release HTTP boundary", () => {
  it("seeds allocation from pending uploads with optional relationship linkage", async () => {
    const client = new AppStoreReleaseClient(appleTestCredential, async (url) =>
      url.includes("/builds?")
        ? json({ data: [{ id: "old", attributes: { version: "12.3", processingState: "VALID" } }] })
        : json({
            data: [
              {
                type: "buildUploads",
                id: "upload",
                attributes: { cfBundleVersion: "15" },
                relationships: { build: linksOnly },
              },
            ],
          }),
    );
    expect(await client.highestBuildNumber("app", "1.2")).toBe(15);
    client.dispose();
  });
  it("uploads exact multipart ranges without JWT headers and commits only after every part", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const parts: string[] = [];
    const http: AscHttp = async (url, init) => {
      calls.push({ url, init });
      if (init.method === "PUT") {
        parts.push(await (init.body as Blob).text());
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/buildUploads")) return json({ data: { id: "upload" } });
      if (url.endsWith("/buildUploadFiles"))
        return json({
          data: {
            id: "file",
            attributes: {
              uploadOperations: [0, 3].map((offset) => ({
                method: "PUT",
                url: `https://upload.apple.com/part-${offset}`,
                offset,
                length: 3,
                requestHeaders: [{ name: "Content-Type", value: "application/octet-stream" }],
              })),
            },
          },
        });
      return json({ data: { id: "file" } });
    };
    const client = new AppStoreReleaseClient(appleTestCredential, http);
    const progress = vi.fn();
    const reserved = vi.fn(async () => {});
    expect(await client.upload("app", action, source, progress, reserved)).toBe("upload");
    expect(parts).toEqual(["abc", "def"]);
    expect(reserved).toHaveBeenCalledWith("upload");
    expect(progress.mock.calls).toEqual([
      [0, 6],
      [3, 6],
      [6, 6],
    ]);
    expect(calls.at(-1)?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toMatchObject({
      data: { attributes: { uploaded: true } },
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      data: {
        attributes: { cfBundleVersion: "8", cfBundleShortVersionString: "1.2", platform: "IOS" },
      },
    });
    client.dispose();
  });
  it.each(["gap", "host", "failure"])(
    "does not commit after %s upload instructions or failure",
    async (scenario) => {
      const methods: string[] = [];
      const http: AscHttp = async (url, init) => {
        methods.push(init.method!);
        if (url.endsWith("/buildUploads")) return json({ data: { id: "upload" } });
        if (init.method === "PUT") return new Response(null, { status: 500 });
        return json({
          data: {
            id: "file",
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url:
                    scenario === "host" ? "https://evil.test/key" : "https://upload.apple.com/part",
                  offset: scenario === "gap" ? 1 : 0,
                  length: 6,
                  requestHeaders: [],
                },
              ],
            },
          },
        });
      };
      const client = new AppStoreReleaseClient(appleTestCredential, http);
      await expect(
        client.upload(
          "app",
          action,
          source,
          () => {},
          async () => {},
        ),
      ).rejects.toMatchObject({ _tag: "AppleError" });
      expect(methods).not.toContain("PATCH");
      client.dispose();
    },
  );
  it("accepts links-only relationships including included resources, paginates and caches Organizer pages", async () => {
    const calls: string[] = [];
    let now = 1000;
    const http: AscHttp = async (url) => {
      calls.push(url);
      if (url.includes("/builds?")) return json(buildPage);
      if (url.includes("betaGroups?")) return json(groups);
      if (url.includes("betaTesters"))
        return json({
          data: [
            {
              id: url.includes("cursor=2") ? "two" : "one",
              type: "betaTesters",
              attributes: { email: "test@example.test", state: "ACCEPTED" },
            },
          ],
          links: {
            next: url.includes("cursor=2")
              ? null
              : "https://api.appstoreconnect.apple.com/v1/betaTesters?cursor=2",
          },
        });
      if (url.includes("appStoreVersions")) return json(versionPage);
      return json({
        data: [
          { type: "reviewSubmissions", id: "review", attributes: { state: "WAITING_FOR_REVIEW" } },
        ],
      });
    };
    const client = new AppStoreReleaseClient(appleTestCredential, http, () => now);
    const result = await client.organizer("app");
    expect(result.testers.map((t) => t.id)).toEqual(["one", "two"]);
    expect(result.builds[0]).toMatchObject({
      version: "1.2",
      buildNumber: "8",
      betaReviewState: "IN_REVIEW",
      expiresAt: null,
    });
    expect(result.versions[0]?.buildId).toBe("build");
    expect(result.reviews[0]?.state).toBe("WAITING_FOR_REVIEW");
    expect(calls.length).toBe(6);
    await client.organizer("app");
    expect(calls.length).toBe(6);
    now += 30_001;
    await client.organizer("app");
    expect(calls.length).toBe(12);
    client.dispose();
  });
  it("rejects hostile pagination before forwarding a JWT", async () => {
    const http = vi.fn<AscHttp>(async () =>
      json({ ...buildPage, links: { next: "https://evil.test/v1/builds" } }),
    );
    const client = new AppStoreReleaseClient(appleTestCredential, http);
    await expect(client.organizer("app")).rejects.toMatchObject({ code: "invalid-response" });
    expect(http).toHaveBeenCalledTimes(1);
    client.dispose();
  });
  it.each(["testflight", "app-store"] as const)(
    "performs the %s review sequence with links-only relationships and never retries writes",
    async (kind) => {
      const writes: { url: string; body: unknown; method: string }[] = [];
      const http: AscHttp = async (url, init) => {
        if (init.method !== "GET") {
          writes.push({ url, body: JSON.parse(String(init.body)), method: init.method! });
          return init.method === "PATCH"
            ? new Response(null, { status: 204 })
            : json({ data: { id: "submission" } });
        }
        if (url.includes("builds?"))
          return json({ ...buildPage, included: buildPage.included.slice(0, 1) });
        if (url.includes("betaGroups")) return json(groups);
        if (url.includes("appStoreVersions")) return json(versionPage);
        if (url.includes("betaBuildLocalizations"))
          return json({
            data: [
              {
                id: "localization",
                type: "betaBuildLocalizations",
                attributes: { locale: "en-US" },
                relationships: { build: linksOnly },
              },
            ],
          });
        return json({ data: [] });
      };
      const beforeWrite = vi.fn(async () => {});
      const client = new AppStoreReleaseClient(
        appleTestCredential,
        http,
        undefined,
        undefined,
        beforeWrite,
      );
      await client.publish(
        "app",
        kind === "testflight"
          ? {
              kind,
              buildId: "build",
              groupIds: ["group"],
              locale: "en-US",
              whatsNew: "Try sign in",
              submitForReview: true,
            }
          : { kind, buildId: "build", versionId: "store-version" },
      );
      expect(writes.length).toBe(kind === "testflight" ? 3 : 4);
      expect(beforeWrite).toHaveBeenCalledTimes(writes.length);
      expect(writes.at(-1)?.url).toContain(
        kind === "testflight" ? "betaAppReviewSubmissions" : "reviewSubmissions/submission",
      );
      client.dispose();
    },
  );
  it("rejects a build from another app before any mutation", async () => {
    const http = vi.fn<AscHttp>(async () =>
      json({ ...buildPage, included: buildPage.included.slice(0, 1) }),
    );
    const client = new AppStoreReleaseClient(appleTestCredential, http);
    await expect(
      client.publish("app", { kind: "app-store", buildId: "other", versionId: "store-version" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(http).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
