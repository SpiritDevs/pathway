// Packaged desktop flavors. The build writes the flavor into the app's
// package.json before signing; the runtime reads it back so an isolated build
// never shares state, URL schemes or OS identity with the production install.

export const PATHWAY_DESKTOP_FLAVORS = ["production", "cua"] as const;
export type PathwayDesktopFlavor = (typeof PATHWAY_DESKTOP_FLAVORS)[number];

/** package.json key holding the packaged flavor. */
export const PATHWAY_DESKTOP_FLAVOR_KEY = "pathwayDesktopFlavor";

/** The side-by-side Computer Use build: its own bundle, scheme, TCC grants and Pathway home. */
export const PATHWAY_CUA_DESKTOP_IDENTITY = {
  displayName: "Pathway Cua",
  bundleId: "com.spiritdevs.pathway.cua",
  scheme: "pathway-cua",
  userDataDirName: "pathway-cua",
  homeDirName: ".pathway-cua",
  linuxExecutableName: "pathway-cua",
  linuxDesktopEntryName: "com.spiritdevs.Pathway.Cua.desktop",
} as const;

/** Missing means production; anything unrecognized is a corrupt artifact, not a fallback. */
export function resolvePackagedDesktopFlavor(value: unknown): PathwayDesktopFlavor {
  if (value === undefined) return "production";
  if (value === "production" || value === "cua") return value;
  throw new Error("The packaged Pathway desktop flavor is invalid. Rebuild the application.");
}
