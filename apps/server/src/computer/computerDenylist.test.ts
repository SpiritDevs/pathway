import { describe, expect, it } from "@effect/vitest";

import { computerDenylistMatch } from "./computerDenylist.ts";

describe("computerDenylistMatch", () => {
  it("matches app names, bundle ids, prefixes, and executable paths", () => {
    expect(computerDenylistMatch({ name: "1Password" })?.matched).toBe("app name 1password");
    expect(computerDenylistMatch({ name: "1Password 8" })?.matched).toBe("app name 1password");
    expect(computerDenylistMatch({ name: "Keychain Access" })?.matched).toBe(
      "app name keychain access",
    );
    expect(computerDenylistMatch({ name: "System Settings" })?.matched).toBe(
      "app name system settings",
    );
    expect(computerDenylistMatch({ name: "SecurityAgent" })?.matched).toBe(
      "app name securityagent",
    );
    expect(computerDenylistMatch({ bundleId: "com.1password.1password" })?.matched).toBe(
      "bundle id com.1password.1password",
    );
    expect(computerDenylistMatch({ bundleId: "com.agilebits.onepassword7" })?.matched).toBe(
      "bundle id com.agilebits.onepassword*",
    );
    expect(computerDenylistMatch({ bundleId: "com.dashlane.dashlanephonefinal" })?.matched).toBe(
      "bundle id com.dashlane.*",
    );
    expect(computerDenylistMatch({ bundleId: "com.bitwarden.desktop" })?.matched).toBe(
      "bundle id com.bitwarden.desktop",
    );
    expect(
      computerDenylistMatch({ name: "/Applications/1Password.app/Contents/MacOS/1Password" })
        ?.matched,
    ).toBe("app name 1password");
  });

  it("does not match ordinary apps or near-miss spellings", () => {
    expect(computerDenylistMatch({ name: "org.kde.konsole" })).toBeUndefined();
    expect(computerDenylistMatch({ name: "Finder" })).toBeUndefined();
    expect(computerDenylistMatch({ name: "passwordsafe" })).toBeUndefined();
    expect(computerDenylistMatch({ bundleId: "com.example.passwordsafe2" })).toBeUndefined();
    expect(computerDenylistMatch({})).toBeUndefined();
  });

  it("refuses anything else that names itself a password manager too", () => {
    // The app-name prefix rule is deliberately broad: a surface calling
    // itself "Passwords …" or "1Password …" is exactly what the denylist
    // exists to keep the agent out of.
    expect(computerDenylistMatch({ name: "Passwords Manager Pro" })?.matched).toBe(
      "app name passwords",
    );
    expect(computerDenylistMatch({ name: "Bitwarden Lite" })?.matched).toBe("app name bitwarden");
  });

  it("reduces an app bundle path with a trailing slash to the app", () => {
    // The path helper stands in for node's basename, which ignores trailing
    // slashes; a bundle directory spelled with one must still be refused.
    expect(computerDenylistMatch({ name: "/Applications/1Password.app/" })?.matched).toBe(
      "app name 1password",
    );
  });
});
