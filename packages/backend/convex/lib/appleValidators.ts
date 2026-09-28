import { v } from "convex/values";
import { domainIdArg } from "./validators.ts";
export const appleScope = v.union(
  v.object({ kind: v.literal("user") }),
  v.object({ kind: v.literal("company"), companyId: domainIdArg }),
);
export const appleAccount = v.object({
  id: v.string(),
  email: v.string(),
  displayName: v.string(),
  scope: appleScope,
  revision: v.number(),
  createdAt: v.number(),
  verifiedAt: v.union(v.number(), v.null()),
});
export const appleTeamType = v.union(
  v.literal("individual"),
  v.literal("organization"),
  v.literal("enterprise"),
  v.literal("unknown"),
);
export const appleTeam = v.object({
  accountId: v.string(),
  teamId: v.string(),
  name: v.string(),
  type: appleTeamType,
});
export const appleFailureCode = v.union(
  v.literal("not-connected"),
  v.literal("cloud-unavailable"),
  v.literal("unauthorized"),
  v.literal("forbidden"),
  v.literal("rate-limited"),
  v.literal("invalid-key"),
  v.literal("invalid-response"),
  v.literal("request-failed"),
  v.literal("credential-changed"),
  v.literal("not-implemented"),
);
export const appleFailure = v.object({
  code: appleFailureCode,
  message: v.string(),
  retryAfterSeconds: v.union(v.number(), v.null()),
});
export const appleIntegration = v.object({
  accountId: v.string(),
  teamId: v.string(),
  accountRevision: v.number(),
  connected: v.boolean(),
  revision: v.number(),
  issuerId: v.union(v.string(), v.null()),
  keyIdSuffix: v.union(v.string(), v.null()),
  lastVerifiedAt: v.union(v.number(), v.null()),
});
export const appleHealth = v.object({
  environmentId: v.string(),
  leaseExpiresAt: v.union(v.number(), v.null()),
  connected: v.boolean(),
  revision: v.number(),
  lastVerifiedAt: v.union(v.number(), v.null()),
  error: v.union(appleFailure, v.null()),
});
export const sealedAppleCredential = {
  keyId: v.string(),
  iv: v.string(),
  ciphertext: v.string(),
  authenticationTag: v.string(),
};
export const appleApp = v.object({ id: v.string(), name: v.string(), bundleId: v.string() });
export const appleProjectLink = v.object({
  companyId: domainIdArg,
  projectId: v.string(),
  accountId: v.string(),
  teamId: v.string(),
  app: appleApp,
  linkedAt: v.number(),
});
