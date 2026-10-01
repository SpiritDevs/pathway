// @effect-diagnostics globalDate:off globalFetch:off -- Injectable HTTP and clock at the ASC boundary.
import * as Schema from "effect/Schema";
import type { ReleaseAction, ReleaseOrganizer } from "@spiritdevs/contracts/releases";
import {
  AppStoreConnectClient,
  appleFailure,
  type AscCredential,
  type AscHttp,
} from "./appStoreConnectApi.ts";

const nullableText = Schema.optional(Schema.NullOr(Schema.String));
const reference = Schema.Struct({ id: Schema.String, type: Schema.String });
const resource = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  relationships: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ data: Schema.Union([Schema.Null, reference, Schema.Array(reference)]) }),
    ),
  ),
});
const page = Schema.Struct({
  data: Schema.Array(resource),
  included: Schema.optional(Schema.Array(resource)),
  links: Schema.optional(Schema.Struct({ next: nullableText })),
});
const decodePage = Schema.decodeUnknownSync(page);
const decodeId = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const requiredText = (value: unknown): string => {
  if (typeof value !== "string")
    throw appleFailure("invalid-response", "Apple returned incomplete release metadata.");
  return value;
};
const relatedId = (r: typeof resource.Type, name: string) => {
  const data = r.relationships?.[name]?.data;
  return data && "id" in data ? data.id : null;
};
const link = (type: string, id: string) => ({ data: { type, id } });
const esc = encodeURIComponent;
export type UploadSource = {
  name: string;
  size: number;
  slice: (offset: number, length: number) => Blob;
};
const uploadFile = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String,
    attributes: Schema.Struct({
      uploadOperations: Schema.Array(
        Schema.Struct({
          method: Schema.String,
          url: Schema.String,
          offset: Schema.Int,
          length: Schema.Int,
          requestHeaders: Schema.Array(
            Schema.Struct({ name: Schema.String, value: Schema.String }),
          ),
        }),
      ),
    }),
  }),
});

/** All mutations are single attempts; ambiguous failures must be reconciled before a new confirmation. */
export class AppStoreReleaseClient extends AppStoreConnectClient {
  readonly http: AscHttp;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly beforeWrite: () => Promise<void>;
  constructor(
    credential: AscCredential,
    http: AscHttp = fetch,
    now: () => number = Date.now,
    signal: AbortSignal = new AbortController().signal,
    beforeWrite: () => Promise<void> = async () => {},
  ) {
    super(credential, http, now);
    this.http = http;
    this.now = now;
    this.signal = signal;
    this.beforeWrite = beforeWrite;
  }
  async #write(path: string, body: unknown, method = "POST") {
    this.signal.throwIfAborted();
    await this.beforeWrite();
    this.signal.throwIfAborted();
    this.clearCache();
    return this.request(path, body, method);
  }
  async #id(path: string, body: unknown, method = "POST") {
    const raw = await this.#write(path, body, method);
    try {
      return decodeId(raw).data.id;
    } catch {
      throw appleFailure("invalid-response", "Apple returned an invalid release resource.");
    }
  }
  #resources(path: string) {
    return this.pages(path, (raw) => {
      const p = decodePage(raw);
      return { items: [...p.data], next: p.links?.next ?? null };
    });
  }
  async organizer(appId: string): Promise<ReleaseOrganizer> {
    const builds = await this.pages(
      `/v1/builds?filter[app]=${esc(appId)}&include=preReleaseVersion,betaAppReviewSubmission,buildBetaDetail&limit=200&sort=-uploadedDate`,
      (raw) => {
        const p = decodePage(raw);
        const included = new Map(p.included?.map((r) => [`${r.type}:${r.id}`, r]));
        return {
          next: p.links?.next ?? null,
          items: p.data.map((b) => {
            const version = included.get(`preReleaseVersions:${relatedId(b, "preReleaseVersion")}`);
            const beta = included.get(
              `betaAppReviewSubmissions:${relatedId(b, "betaAppReviewSubmission")}`,
            );
            const detail = included.get(`buildBetaDetails:${relatedId(b, "buildBetaDetail")}`);
            return {
              id: b.id,
              version: text(version?.attributes.version),
              buildNumber: requiredText(b.attributes.version),
              processingState: requiredText(b.attributes.processingState),
              expiresAt: text(b.attributes.expirationDate),
              uploadedDate: text(b.attributes.uploadedDate),
              betaReviewState: text(beta?.attributes.betaReviewState),
              internalBuildState: text(detail?.attributes.internalBuildState),
              externalBuildState: text(detail?.attributes.externalBuildState),
            };
          }),
        };
      },
    );
    const groups = await this.listBetaGroups(appId);
    const testers = (
      await this.#resources(`/v1/betaTesters?filter[apps]=${esc(appId)}&limit=200`)
    ).map((t) => ({
      id: t.id,
      email: text(t.attributes.email),
      firstName: text(t.attributes.firstName),
      lastName: text(t.attributes.lastName),
      state: text(t.attributes.state),
    }));
    const versions = (
      await this.#resources(`/v1/apps/${esc(appId)}/appStoreVersions?include=build&limit=200`)
    ).map((v) => ({
      id: v.id,
      version: requiredText(v.attributes.versionString),
      platform: requiredText(v.attributes.platform),
      state: requiredText(v.attributes.appVersionState ?? v.attributes.appStoreState),
      buildId: relatedId(v, "build"),
    }));
    const reviews = (
      await this.#resources(`/v1/apps/${esc(appId)}/reviewSubmissions?limit=50`)
    ).map((r) => ({
      id: r.id,
      state: requiredText(r.attributes.state),
      submittedDate: text(r.attributes.submittedDate),
    }));
    return { builds, groups, testers, versions, reviews, fetchedAt: this.now() };
  }
  /** Includes in-progress uploads so an external upload is not mistaken for a free number. */
  async highestBuildNumber(appId: string, version: string): Promise<number> {
    this.clearCache();
    const builds = await this.listBuilds(appId);
    const uploads = await this.#resources(
      `/v1/apps/${esc(appId)}/buildUploads?filter[cfBundleShortVersionString]=${esc(version)}&limit=200`,
    );
    const numbers = [
      ...builds
        .filter((b) => b.version === version || b.version === null)
        .map((b) => b.buildNumber),
      ...uploads.map((u) => requiredText(u.attributes.cfBundleVersion)),
    ];
    // Advancing the first component also sorts after existing dotted build numbers.
    return numbers.reduce((maximum, n) => {
      if (!/^\d+(?:\.\d+){0,2}$/u.test(n))
        throw appleFailure("invalid-response", "Apple returned an unsupported build number.");
      const major = Number(n.split(".")[0]);
      if (!Number.isSafeInteger(major))
        throw appleFailure("invalid-response", "Apple returned an unsupported build number.");
      return Math.max(maximum, major);
    }, 0);
  }
  async upload(
    appId: string,
    action: Extract<ReleaseAction, { kind: "upload" }>,
    source: UploadSource,
    progress: (bytes: number, total: number) => void,
    reserved: (id: string) => Promise<void>,
  ): Promise<string> {
    const uploadId = await this.#id("/v1/buildUploads", {
      data: {
        type: "buildUploads",
        attributes: {
          cfBundleShortVersionString: action.version,
          cfBundleVersion: action.buildNumber,
          platform: action.platform,
        },
        relationships: { app: link("apps", appId) },
      },
    });
    await reserved(uploadId);
    const raw = await this.#write("/v1/buildUploadFiles", {
      data: {
        type: "buildUploadFiles",
        attributes: {
          fileName: source.name,
          fileSize: source.size,
          uti: action.platform === "MAC_OS" ? "com.apple.pkg" : "com.apple.ipa",
          assetType: "ASSET",
        },
        relationships: { buildUpload: link("buildUploads", uploadId) },
      },
    });
    let file: typeof uploadFile.Type;
    try {
      file = Schema.decodeUnknownSync(uploadFile)(raw);
    } catch {
      throw appleFailure("invalid-response", "Apple returned invalid upload instructions.");
    }
    const operations = [...file.data.attributes.uploadOperations].sort(
      (a, b) => a.offset - b.offset,
    );
    let end = 0;
    for (const op of operations) {
      let url: URL;
      try {
        url = new URL(op.url);
      } catch {
        throw appleFailure("invalid-response", "Apple returned an invalid upload URL.");
      }
      if (
        op.offset !== end ||
        !Number.isSafeInteger(op.length) ||
        op.length <= 0 ||
        op.offset + op.length > source.size ||
        op.method !== "PUT" ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443") ||
        !url.hostname.endsWith(".apple.com")
      )
        throw appleFailure("invalid-response", "Apple returned invalid upload instructions.");
      end += op.length;
    }
    if (end !== source.size || end === 0)
      throw appleFailure("invalid-response", "Apple upload ranges do not cover the artifact.");
    let bytes = 0;
    progress(bytes, source.size);
    for (const op of operations) {
      await this.beforeWrite();
      this.signal.throwIfAborted();
      const headers = new Headers();
      for (const header of op.requestHeaders) {
        if (/^(authorization|cookie|host)$/iu.test(header.name))
          throw appleFailure("invalid-response", "Apple returned invalid upload headers.");
        headers.set(header.name, header.value);
      }
      let response: Response;
      try {
        response = await this.http(op.url, {
          method: "PUT",
          headers,
          body: source.slice(op.offset, op.length),
          redirect: "error",
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]),
        });
      } catch {
        throw appleFailure(
          "request-failed",
          "The build upload was interrupted. Check its status before retrying.",
        );
      }
      await response.body?.cancel();
      if (!response.ok)
        throw appleFailure(
          "request-failed",
          "Apple rejected a build upload part. Check its status before retrying.",
        );
      bytes += op.length;
      progress(bytes, source.size);
    }
    await this.#write(
      `/v1/buildUploadFiles/${esc(file.data.id)}`,
      { data: { type: "buildUploadFiles", id: file.data.id, attributes: { uploaded: true } } },
      "PATCH",
    );
    return uploadId;
  }
  async publish(
    appId: string,
    action: Exclude<ReleaseAction, { kind: "upload" }>,
  ): Promise<string> {
    // IDs are checked against this app before any outward-facing change.
    this.clearCache();
    if (
      !(await this.listBuilds(appId)).some(
        (b) => b.id === action.buildId && b.processingState === "VALID",
      )
    )
      throw appleFailure("forbidden", "Select a processed build belonging to this app.");
    if (action.kind === "testflight") {
      const groups = await this.listBetaGroups(appId);
      if (action.groupIds.some((id) => !groups.some((g) => g.id === id)))
        throw appleFailure("forbidden", "Select beta groups belonging to this app.");
      const localizations = await this.#resources(
        `/v1/builds/${esc(action.buildId)}/betaBuildLocalizations?limit=200`,
      );
      const existing = localizations.find((l) => l.attributes.locale === action.locale);
      await this.#write(
        existing ? `/v1/betaBuildLocalizations/${esc(existing.id)}` : "/v1/betaBuildLocalizations",
        {
          data: {
            type: "betaBuildLocalizations",
            ...(existing ? { id: existing.id } : {}),
            attributes: {
              whatsNew: action.whatsNew,
              ...(!existing ? { locale: action.locale } : {}),
            },
            ...(!existing ? { relationships: { build: link("builds", action.buildId) } } : {}),
          },
        },
        existing ? "PATCH" : "POST",
      );
      if (action.groupIds.length)
        await this.#write(`/v1/builds/${esc(action.buildId)}/relationships/betaGroups`, {
          data: action.groupIds.map((id) => ({ type: "betaGroups", id })),
        });
      if (action.submitForReview)
        return this.#id("/v1/betaAppReviewSubmissions", {
          data: {
            type: "betaAppReviewSubmissions",
            relationships: { build: link("builds", action.buildId) },
          },
        });
      return action.buildId;
    }
    const versions = await this.#resources(`/v1/apps/${esc(appId)}/appStoreVersions?limit=200`);
    const version = versions.find((v) => v.id === action.versionId);
    if (!version)
      throw appleFailure("forbidden", "Select an App Store version belonging to this app.");
    await this.#write(
      `/v1/appStoreVersions/${esc(action.versionId)}/relationships/build`,
      link("builds", action.buildId),
      "PATCH",
    );
    const submissionId = await this.#id("/v1/reviewSubmissions", {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: requiredText(version.attributes.platform) },
        relationships: { app: link("apps", appId) },
      },
    });
    await this.#write("/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: link("reviewSubmissions", submissionId),
          appStoreVersion: link("appStoreVersions", action.versionId),
        },
      },
    });
    await this.#write(
      `/v1/reviewSubmissions/${esc(submissionId)}`,
      { data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } } },
      "PATCH",
    );
    return submissionId;
  }
}
