import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { configureWebAuthn } = vi.hoisted(() => ({ configureWebAuthn: vi.fn() }));
vi.mock("electron", () => ({ app: { configureWebAuthn, isPackaged: true } }));
import { configureDesktopWebAuthn, readDesktopWebAuthnKeychainGroup } from "./DesktopWebAuthn.ts";

describe("configureDesktopWebAuthn", () => {
  beforeEach(() => configureWebAuthn.mockReset());
  it("only accepts the signed browser keychain group in packaged metadata", () => {
    expect(
      readDesktopWebAuthnKeychainGroup(
        '{"pathwayWebAuthnKeychainGroup":"ABC1234567.com.spiritdevs.pathway.webauthn"}',
      ),
    ).toBe("ABC1234567.com.spiritdevs.pathway.webauthn");
    expect(
      readDesktopWebAuthnKeychainGroup('{"pathwayWebAuthnKeychainGroup":"another.app"}'),
    ).toBeUndefined();
    expect(readDesktopWebAuthnKeychainGroup("{}")).toBeUndefined();
  });
  it("enables the signed application's own Secure Enclave credential group", () => {
    const group = "ABC1234567.com.spiritdevs.pathway.webauthn";
    expect(configureDesktopWebAuthn("darwin", true, group)).toBe(true);
    expect(configureWebAuthn).toHaveBeenCalledWith({ touchID: { keychainAccessGroup: group } });
  });
  it("does not advertise platform credentials in unsigned development or other platforms", () => {
    expect(configureDesktopWebAuthn("darwin", false, "group")).toBe(false);
    expect(configureDesktopWebAuthn("darwin", true, "")).toBe(false);
    expect(configureDesktopWebAuthn("linux", true, "group")).toBe(false);
    expect(configureDesktopWebAuthn("win32", true, "group")).toBe(false);
    expect(configureWebAuthn).not.toHaveBeenCalled();
  });
});
