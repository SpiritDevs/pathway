// @effect-diagnostics nodeBuiltinImport:off - Read signed artifact metadata once during Electron startup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { app } from "electron";
import * as Schema from "effect/Schema";

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
  }),
);

const decodeSignedBrowserMetadata = Schema.decodeUnknownSync(SignedBrowserMetadata);

export function readDesktopWebAuthnKeychainGroup(packageJson: string): string | undefined {
  const metadata = decodeSignedBrowserMetadata(packageJson);
  const group = metadata.pathwayWebAuthnKeychainGroup;
  return group && /^[A-Z0-9]{10}\.com\.spiritdevs\.pathway\.webauthn$/.test(group)
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
