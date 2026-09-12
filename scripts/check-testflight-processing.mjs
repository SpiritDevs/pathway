import { sign } from "node:crypto";

const { APPLE_API_KEY: key, APPLE_API_KEY_ID: kid, APPLE_API_ISSUER: issuer } = process.env;
if (!key || !kid || !issuer) {
  throw new Error("Required Apple API credentials are not configured");
}
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: "ES256", kid, typ: "JWT" })}.${encode({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
let signature;
try {
  signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
} catch {
  throw new Error("Configured Apple API key could not sign a request");
}
const token = `${unsigned}.${signature}`;
const request = async (path, query = {}, update = undefined) => {
  const url = new URL(path, "https://api.appstoreconnect.apple.com");
  if (url.origin !== "https://api.appstoreconnect.apple.com") throw new Error("Unexpected Apple API origin");
  url.search = new URLSearchParams(query).toString();
  const response = await fetch(url, {
    method: update ? "PATCH" : "GET",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, ...(update ? { "Content-Type": "application/json" } : {}) },
    ...(update ? { body: JSON.stringify(update) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Apple API returned HTTP ${response.status} without JSON`); }
  if (!response.ok) {
    console.log(JSON.stringify({ path: url.pathname, httpStatus: response.status, errors: body.errors?.map(({ code, title }) => ({ code, title })) }));
    throw new Error(`Apple API request failed with HTTP ${response.status}`);
  }
  return body;
};
const get = (path, query = {}) => request(path, query);
const apps = await get("/v1/apps", { "filter[bundleId]": "com.spiritdevs.pathway" });
if (apps.data?.length !== 1) throw new Error(`Expected one Pathway app, found ${apps.data?.length ?? 0}`);
const app = apps.data[0];
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), appName: app.attributes.name, bundleId: app.attributes.bundleId }));
let priorDeclaration;
let targetBuildFound = false;
for (const version of ["12", "13", "14"]) {
  const result = await get("/v1/builds", { "filter[app]": app.id, "filter[version]": version, include: "preReleaseVersion", limit: "20" });
  console.log(JSON.stringify({ buildNumber: version, matches: result.data.length }));
  for (const build of result.data) {
    const marketing = result.included?.find((item) => item.type === "preReleaseVersions" && item.id === build.relationships.preReleaseVersion?.data?.id);
    console.log(JSON.stringify({ buildId: build.id, buildNumber: build.attributes.version, marketingVersion: marketing?.attributes.version, uploadedDate: build.attributes.uploadedDate, processingState: build.attributes.processingState, expired: build.attributes.expired, usesNonExemptEncryption: build.attributes.usesNonExemptEncryption }));
    if (version === "12" && marketing?.attributes.version === "1.0.11" && build.attributes.processingState === "VALID") {
      priorDeclaration = build.attributes.usesNonExemptEncryption;
    }
    if (version === "14") {
      targetBuildFound = true;
      if (process.env.COMPLETE_BUILD_14 === "true") {
        if (marketing?.attributes.version !== "1.0.13" || build.attributes.processingState !== "VALID" || build.attributes.expired) throw new Error("Build 14 is not the expected valid release");
        if (priorDeclaration !== false) throw new Error("Existing build 12 encryption declaration does not match the verified source");
        if (build.attributes.usesNonExemptEncryption === true) throw new Error("Build 14 has a conflicting encryption declaration");
        if (build.attributes.usesNonExemptEncryption == null) {
          const updated = await request(`/v1/builds/${encodeURIComponent(build.id)}`, {}, { data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } } });
          console.log(JSON.stringify({ buildNumber: version, action: "carriedForwardExistingEncryptionDeclaration", usesNonExemptEncryption: updated.data.attributes.usesNonExemptEncryption }));
        }
      }
    }
    const beta = await get(`/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`);
    console.log(JSON.stringify({ buildNumber: version, betaState: beta.data?.attributes }));
    
  }
}

const groups = await get("/v1/betaGroups", { "filter[app]": app.id, include: "builds", "limit[builds]": "1000", limit: "200" });
console.log(JSON.stringify({ testerGroups: groups.data.map(({ id, attributes, relationships }) => ({ id, name: attributes.name, isInternalGroup: attributes.isInternalGroup, hasAccessToAllBuilds: attributes.hasAccessToAllBuilds, relevantBuilds: (relationships?.builds?.data ?? []).map((item) => groups.included?.find((build) => build.type === "builds" && build.id === item.id)?.attributes.version).filter((version) => version === "13" || version === "14") })), hasMoreGroups: Boolean(groups.links?.next) }));

if (process.env.COMPLETE_BUILD_14 === "true" && !targetBuildFound) throw new Error("Build 14 is not uploaded yet");
