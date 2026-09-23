// @effect-diagnostics nodeBuiltinImport:off - Read signed artifact metadata once during Electron startup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { app } from "electron";
import * as Schema from "effect/Schema";
import {
  PATHWAY_CUA_DESKTOP_IDENTITY,
  resolvePackagedDesktopFlavor,
  type PathwayDesktopFlavor,
} from "@spiritdevs/shared/desktopFlavor";

export class DesktopWebAuthnConfigurationError extends Schema.TaggedErrorClass<DesktopWebAuthnConfigurationError>()(
  "DesktopWebAuthnConfigurationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Platform passkeys could not be configured for this desktop build.";
  }
}

const SignedBrowserMetadata = Schema.fromJsonString(
  Schema.Struct({
    pathwayWebAuthnKeychainGroup: Schema.optional(Schema.String),
    pathwayDesktopFlavor: Schema.optional(Schema.Unknown),
  }),
);

const decodeSignedBrowserMetadata = Schema.decodeUnknownSync(SignedBrowserMetadata);

const WEBAUTHN_APP_IDS = {
  production: "com.spiritdevs.pathway",
  cua: PATHWAY_CUA_DESKTOP_IDENTITY.bundleId,
} as const satisfies Record<PathwayDesktopFlavor, string>;

/** Accepts only `<TEAM_ID>.<flavor bundle id>.webauthn`, the group the build signed for this flavor. */
export function readDesktopWebAuthnKeychainGroup(packageJson: string): string | undefined {
  const metadata = decodeSignedBrowserMetadata(packageJson);
  const group = metadata.pathwayWebAuthnKeychainGroup;
  const appId = WEBAUTHN_APP_IDS[resolvePackagedDesktopFlavor(metadata.pathwayDesktopFlavor)];
  return group && /^[A-Z0-9]{10}\./.test(group) && group.slice(11) === `${appId}.webauthn`
    ? group
    : undefined;
}

/** Must match the signed keychain-access-groups entitlement in the release artifact. */
export function configureDesktopWebAuthn(
  platform: NodeJS.Platform,
  isPackaged = app.isPackaged,
  configuredGroup?: string,
): boolean {
  if (platform !== "darwin" || !isPackaged) return false;
  const keychainAccessGroup =
    configuredGroup ??
    readDesktopWebAuthnKeychainGroup(
      NodeFS.readFileSync(NodePath.join(app.getAppPath(), "package.json"), "utf8"),
    );
  if (!keychainAccessGroup) return false;
  app.configureWebAuthn({ touchID: { keychainAccessGroup } });
  return true;
}
