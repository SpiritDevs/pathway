// @effect-diagnostics globalDate:off globalFetch:off -- Shared Promise client runs in Convex actions and Node; clock and HTTP are injectable.
/** Minimal ASC reader shared by cloud key validation and environment reads. No persistence. */
import * as Schema from "effect/Schema";
import {
  AppleError,
  type AppleApp,
  type AppleBuild,
  type AppleBetaGroup,
  AppleBundleId,
} from "@spiritdevs/contracts/apple";

export const AscCredential = Schema.Struct({
  issuerId: Schema.String,
  keyId: Schema.String,
  privateKey: Schema.String,
});
export type AscCredential = typeof AscCredential.Type;
export type AscHttp = (url: string, init: RequestInit) => Promise<Response>;
export const ASC_ORIGIN = "https://api.appstoreconnect.apple.com";
const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=/gu, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
const encodePart = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
export const appleFailure = (
  code: typeof AppleError.Type.code,
  message: string,
  retryAfterSeconds: number | null = null,
) => new AppleError({ code, message, retryAfterSeconds });

export async function signAscToken(credential: AscCredential, nowMs: number): Promise<string> {
  try {
    if (
      !/^[A-Za-z0-9]{10}$/u.test(credential.keyId) ||
      !/^[a-f0-9-]{36}$/iu.test(credential.issuerId) ||
      credential.privateKey.length > 8192
    )
      throw new Error();
    const pem = credential.privateKey.trim();
    if (
      !pem.startsWith("-----BEGIN PRIVATE KEY-----") ||
      !pem.endsWith("-----END PRIVATE KEY-----")
    )
      throw new Error();
    const bytes = Uint8Array.from(
      atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, "")),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const iat = Math.floor(nowMs / 1000);
    const input = `${encodePart({ alg: "ES256", kid: credential.keyId, typ: "JWT" })}.${encodePart({ iss: credential.issuerId, iat, exp: iat + 600, aud: "appstoreconnect-v1" })}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      encoder.encode(input),
    );
    return `${input}.${base64url(new Uint8Array(signature))}`;
  } catch {
    throw appleFailure(
      "invalid-key",
      "Provide an App Store Connect team API key in P-256 PKCS#8 format.",
    );
  }
}

const links = Schema.optional(
  Schema.Struct({ next: Schema.optional(Schema.NullOr(Schema.String)) }),
);
const appResource = Schema.Struct({
  id: Schema.String,
  attributes: Schema.Struct({ name: Schema.String, bundleId: Schema.String }),
});
const appPage = Schema.Struct({ data: Schema.Array(appResource), links });
const betaPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      attributes: Schema.Struct({ name: Schema.String, isInternalGroup: Schema.Boolean }),
    }),
  ),
  links,
});
const versionResource = Schema.Struct({
  type: Schema.Literal("preReleaseVersions"),
  id: Schema.String,
  attributes: Schema.Struct({ version: Schema.String }),
});
const buildPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      attributes: Schema.Struct({
        version: Schema.String,
        processingState: Schema.String,
        expirationDate: Schema.optional(Schema.NullOr(Schema.String)),
        uploadedDate: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      relationships: Schema.optional(
        Schema.Struct({
          preReleaseVersion: Schema.optional(
            Schema.Struct({
              data: Schema.NullOr(Schema.Struct({ id: Schema.String, type: Schema.String })),
            }),
          ),
        }),
      ),
    }),
  ),
  included: Schema.optional(Schema.Array(versionResource)),
  links,
});

const decodeBundle = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      id: Schema.String,
      attributes: Schema.Struct({
        name: Schema.String,
        identifier: Schema.String,
        platform: AppleBundleId.fields.platform,
      }),
    }),
  }),
);
const decodeApps = Schema.decodeUnknownSync(appPage);
const decodeBuilds = Schema.decodeUnknownSync(buildPage);
const decodeGroups = Schema.decodeUnknownSync(betaPage);

export function retryAfterSeconds(header: string | null, now: number): number | null {
  if (header === null) return null;
  if (/^\d+(\.\d+)?$/u.test(header.trim())) return Math.max(0, Math.ceil(Number(header)));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

export class AppStoreConnectClient {
  #credential: AscCredential | null;
  #token: { value: string; expiresAt: number } | null = null;
  #cache = new Map<string, { until: number; value: unknown }>();
  #abort = new AbortController();
  readonly #http: AscHttp;
  readonly #now: () => number;
  #lastVerifiedAt: number | null = null;
  get lastVerifiedAt(): number | null {
    return this.#lastVerifiedAt;
  }
  constructor(credential: AscCredential, http: AscHttp = fetch, now: () => number = Date.now) {
    this.#credential = credential;
    this.#http = http;
    this.#now = now;
  }
  /** Releases all key, JWT and data references, including in-flight requests. */
  dispose(): void {
    this.#credential = null;
    this.#token = null;
    this.#cache.clear();
    this.#abort.abort();
  }
  clearCache(): void {
    this.#cache.clear();
  }
  async #request(path: string, body?: unknown): Promise<unknown> {
    if (this.#credential === null)
      throw appleFailure(
        "credential-changed",
        "The Apple credential lease ended. Retry the request.",
      );
    let url: URL;
    try {
      url = new URL(path, ASC_ORIGIN);
    } catch {
      throw appleFailure("invalid-response", "Apple returned an invalid pagination URL.");
    }
    if (
      url.origin !== ASC_ORIGIN ||
      url.username ||
      url.password ||
      !url.pathname.startsWith("/v1/")
    )
      throw appleFailure("invalid-response", "Apple returned an invalid pagination URL.");
    if (this.#token === null || this.#token.expiresAt - 60_000 <= this.#now()) {
      const started = this.#now();
      const value = await signAscToken(this.#credential, started);
      if (this.#credential === null)
        throw appleFailure(
          "credential-changed",
          "The Apple credential lease ended. Retry the request.",
        );
      this.#token = { value, expiresAt: started + 600_000 };
    }
    let response: Response;
    try {
      response = await this.#http(url.href, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.#token.value}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      throw appleFailure("request-failed", "Could not reach App Store Connect.");
    }
    if (!response.ok) {
      if (response.status === 401) {
        this.#token = null;
        throw appleFailure("unauthorized", "App Store Connect rejected the API key.");
      }
      if (response.status === 403)
        throw appleFailure(
          "forbidden",
          "The API key does not have access to this App Store Connect resource.",
        );
      if (response.status === 429)
        throw appleFailure(
          "rate-limited",
          "App Store Connect rate limit reached.",
          retryAfterSeconds(response.headers.get("retry-after"), this.#now()),
        );
      throw appleFailure("request-failed", "App Store Connect could not complete the request.");
    }
    try {
      const body: unknown = await response.json();
      this.#lastVerifiedAt = this.#now();
      return body;
    } catch {
      throw appleFailure("invalid-response", "App Store Connect returned invalid JSON.");
    }
  }
  async #pages<A>(
    path: string,
    decode: (value: unknown) => { items: A[]; next: string | null },
  ): Promise<A[]> {
    const cached = this.#cache.get(path);
    if (cached && cached.until > this.#now()) return cached.value as A[];
    const items: A[] = [];
    const visited = new Set<string>();
    let next: string | null = path;
    while (next !== null) {
      let href: string;
      try {
        href = new URL(next, ASC_ORIGIN).href;
      } catch {
        throw appleFailure("invalid-response", "Apple returned an invalid pagination URL.");
      }
      if (visited.has(href) || visited.size >= 1000)
        throw appleFailure("invalid-response", "App Store Connect pagination did not finish.");
      visited.add(href);
      const raw = await this.#request(href);
      let page: { items: A[]; next: string | null };
      try {
        page = decode(raw);
      } catch {
        throw appleFailure(
          "invalid-response",
          "App Store Connect returned an unexpected response.",
        );
      }
      items.push(...page.items);
      next = page.next;
    }
    if (this.#credential === null)
      throw appleFailure(
        "credential-changed",
        "The Apple credential lease ended. Retry the request.",
      );
    if (this.#cache.size >= 100) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(path, { until: this.#now() + 30_000, value: items });
    return items;
  }
  async registerBundleId(input: {
    name: string;
    identifier: string;
    platform: typeof AppleBundleId.Type.platform;
  }): Promise<typeof AppleBundleId.Type> {
    const raw = await this.#request("/v1/bundleIds", {
      data: {
        type: "bundleIds",
        attributes: { name: input.name, identifier: input.identifier, platform: input.platform },
      },
    });
    try {
      const result = decodeBundle(raw);
      return { id: result.data.id, ...result.data.attributes };
    } catch {
      throw appleFailure(
        "invalid-response",
        "App Store Connect returned an unexpected bundle ID response.",
      );
    }
  }
  listApps(): Promise<AppleApp[]> {
    return this.#pages("/v1/apps?limit=200&fields[apps]=name,bundleId", (raw) => {
      const page = decodeApps(raw);
      return {
        items: page.data.map((a) => ({
          id: a.id,
          name: a.attributes.name,
          bundleId: a.attributes.bundleId,
        })),
        next: page.links?.next ?? null,
      };
    });
  }
  listBuilds(appId: string): Promise<AppleBuild[]> {
    return this.#pages(
      `/v1/builds?filter[app]=${encodeURIComponent(appId)}&include=preReleaseVersion&fields[builds]=version,processingState,expirationDate,uploadedDate,preReleaseVersion&fields[preReleaseVersions]=version&limit=200&sort=-uploadedDate`,
      (raw) => {
        const page = decodeBuilds(raw);
        const versions = new Map(page.included?.map((v) => [v.id, v.attributes.version]));
        return {
          items: page.data.map((b) => ({
            id: b.id,
            version: versions.get(b.relationships?.preReleaseVersion?.data?.id ?? "") ?? null,
            buildNumber: b.attributes.version,
            processingState: b.attributes.processingState,
            expiresAt: b.attributes.expirationDate ?? null,
            uploadedDate: b.attributes.uploadedDate ?? null,
          })),
          next: page.links?.next ?? null,
        };
      },
    );
  }
  listBetaGroups(appId: string): Promise<AppleBetaGroup[]> {
    return this.#pages(
      `/v1/betaGroups?filter[app]=${encodeURIComponent(appId)}&limit=200`,
      (raw) => {
        const page = decodeGroups(raw);
        return {
          items: page.data.map((g) => ({
            id: g.id,
            name: g.attributes.name,
            isInternalGroup: g.attributes.isInternalGroup,
          })),
          next: page.links?.next ?? null,
        };
      },
    );
  }
}
