// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Independent Node verifier and controlled clock exercise the public RFC vector.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  AppStoreConnectClient,
  signAscToken,
  retryAfterSeconds,
  ASC_ORIGIN,
  type AscHttp,
} from "./appStoreConnectApi.ts";
import { appleTestCredential, appleTestPublicKey } from "./fixtures/appleTestKey.ts";
const NOW = 1_800_000_000_000;
const app = { id: "1", attributes: { name: "Example", bundleId: "com.example.app" } };
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, ...(headers === undefined ? {} : { headers }) });

describe("App Store Connect client", () => {
  it("signs the RFC 6979 P-256 key with JOSE's raw ES256 signature and Apple's claims", async () => {
    const token = await signAscToken(appleTestCredential, NOW);
    const [head, body, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "TESTKEY001",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({
      iss: appleTestCredential.issuerId,
      aud: "appstoreconnect-v1",
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
    });
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${head}.${body}`),
        { key: appleTestPublicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${head}.${body}x`),
        { key: appleTestPublicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(false);
  });
  it("paginates apps, caches for 30 seconds and refreshes JWTs near expiry", async () => {
    let now = NOW;
    const tokens: string[] = [];
    const http = vi.fn<AscHttp>(async (url, init) => {
      tokens.push(new Headers(init?.headers).get("authorization")!);
      return String(url).includes("cursor=")
        ? json({ data: [{ ...app, id: "2" }], links: { next: null } })
        : json({ data: [app], links: { next: `${ASC_ORIGIN}/v1/apps?cursor=next` } });
    });
    const client = new AppStoreConnectClient(appleTestCredential, http, () => now);
    expect(await client.listApps()).toHaveLength(2);
    expect(await client.listApps()).toHaveLength(2);
    expect(http).toHaveBeenCalledTimes(2);
    now += 30_001;
    await client.listApps();
    expect(http).toHaveBeenCalledTimes(4);
    expect(new Set(tokens).size).toBe(1);
    now = NOW + 540_001;
    await client.listApps();
    expect(new Set(tokens).size).toBe(2);
    client.dispose();
    await expect(client.listApps()).rejects.toMatchObject({ code: "credential-changed" });
  });
  it("maps builds to marketing versions separately from build numbers, including each page's versions", async () => {
    const http = vi.fn<AscHttp>(async (url) => {
      expect(String(url)).toContain("filter[app]=app%2Fid");
      return json({
        data: [
          {
            id: "build",
            attributes: {
              version: "42",
              processingState: "VALID",
              expirationDate: "2026-12-01T00:00:00Z",
              uploadedDate: "2026-09-01T00:00:00Z",
            },
            relationships: {
              preReleaseVersion: { data: { id: "version", type: "preReleaseVersions" } },
            },
          },
        ],
        included: [{ type: "preReleaseVersions", id: "version", attributes: { version: "1.2.3" } }],
      });
    });
    const client = new AppStoreConnectClient(appleTestCredential, http, () => NOW);
    expect(await client.listBuilds("app/id")).toEqual([
      {
        id: "build",
        version: "1.2.3",
        buildNumber: "42",
        processingState: "VALID",
        expiresAt: "2026-12-01T00:00:00Z",
        uploadedDate: "2026-09-01T00:00:00Z",
      },
    ]);
  });
  it("paginates beta groups and posts a bundle ID with Apple's resource shape", async () => {
    const http = vi.fn<AscHttp>(async (url, init) => {
      if (String(url).endsWith("/bundleIds")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          data: {
            type: "bundleIds",
            attributes: { name: "My app", identifier: "com.example.new", platform: "UNIVERSAL" },
          },
        });
        return json(
          {
            data: {
              id: "bundle",
              attributes: { name: "My app", identifier: "com.example.new", platform: "UNIVERSAL" },
            },
          },
          201,
        );
      }
      const second = String(url).includes("cursor=");
      return json({
        data: [
          {
            id: second ? "external" : "internal",
            attributes: { name: "Testers", isInternalGroup: !second },
          },
        ],
        links: { next: second ? null : "/v1/betaGroups?cursor=next" },
      });
    });
    const client = new AppStoreConnectClient(appleTestCredential, http, () => NOW);
    expect(await client.listBetaGroups("app")).toHaveLength(2);
    expect(
      await client.registerBundleId({
        name: "My app",
        identifier: "com.example.new",
        platform: "UNIVERSAL",
      }),
    ).toMatchObject({ id: "bundle" });
  });
  it.each([
    [401, "unauthorized", null],
    [403, "forbidden", null],
    [429, "rate-limited", 12],
    [500, "request-failed", null],
  ] as const)(
    "maps HTTP %s without reflecting secrets in upstream errors",
    async (status, code, retryAfter) => {
      const client = new AppStoreConnectClient(
        appleTestCredential,
        async () =>
          json({ detail: appleTestCredential.privateKey }, status, { "Retry-After": "12" }),
        () => NOW,
      );
      const error = await client.listApps().catch((e: unknown) => e);
      expect(error).toMatchObject({ code, retryAfterSeconds: retryAfter });
      expect(JSON.stringify(error)).not.toContain("PRIVATE KEY");
    },
  );
  it("supports HTTP-date Retry-After and sanitizes invalid responses, keys and transport errors", async () => {
    expect(retryAfterSeconds(new Date(NOW + 15_000).toUTCString(), NOW)).toBe(15);
    expect(retryAfterSeconds("invalid", NOW)).toBeNull();
    await expect(
      signAscToken({ ...appleTestCredential, privateKey: "secret bad key" }, NOW),
    ).rejects.toMatchObject({ code: "invalid-key" });
    await expect(
      new AppStoreConnectClient(
        appleTestCredential,
        async () => json({ data: [{ privateKey: "secret" }] }),
        () => NOW,
      ).listApps(),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(
      new AppStoreConnectClient(
        appleTestCredential,
        async () => {
          throw new Error(appleTestCredential.privateKey);
        },
        () => NOW,
      ).listApps(),
    ).rejects.toMatchObject({ code: "request-failed" });
  });
  it.each(["https://evil.test/v1/apps", "https://user:pass@api.appstoreconnect.apple.com/v1/apps"])(
    "never forwards a bearer to unsafe pagination %s",
    async (next) => {
      const http = vi.fn<AscHttp>(async () => json({ data: [], links: { next } }));
      await expect(
        new AppStoreConnectClient(appleTestCredential, http, () => NOW).listApps(),
      ).rejects.toMatchObject({ code: "invalid-response" });
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
});
