import { v } from "convex/values";
export const releaseTarget = {
  companyId: v.string(),
  accountId: v.string(),
  teamId: v.string(),
  appId: v.string(),
};
export const releasePlatform = v.union(
  v.literal("IOS"),
  v.literal("MAC_OS"),
  v.literal("TV_OS"),
  v.literal("VISION_OS"),
);
export const releaseAction = v.union(
  v.object({
    kind: v.literal("upload"),
    archiveId: v.string(),
    artifactSha256: v.string(),
    version: v.string(),
    buildNumber: v.string(),
    platform: releasePlatform,
  }),
  v.object({
    kind: v.literal("testflight"),
    buildId: v.string(),
    groupIds: v.array(v.string()),
    locale: v.string(),
    whatsNew: v.string(),
    submitForReview: v.boolean(),
  }),
  v.object({ kind: v.literal("app-store"), buildId: v.string(), versionId: v.string() }),
);
export const releaseIntent = v.object({
  id: v.string(),
  target: v.object(releaseTarget),
  environmentId: v.string(),
  action: releaseAction,
  state: v.union(
    v.literal("pending"),
    v.literal("approved"),
    v.literal("consumed"),
    v.literal("cancelled"),
  ),
  expiresAt: v.number(),
});
