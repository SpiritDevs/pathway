import { describe, expect, it, vi } from "vite-plus/test";
import type { SelectWebauthnAccountDetails } from "electron";
vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));
import { selectPreviewWebAuthnAccount } from "./WebAuthn.ts";

function request() {
  return {
    relyingPartyId: "example.com",
    accounts: [
      { credentialId: "private-account-a", name: "first@example.com" },
      { credentialId: "private-account-b", name: "second@example.com" },
    ],
    frame: { url: "https://example.com/login" },
  } as SelectWebauthnAccountDetails;
}

describe("selectPreviewWebAuthnAccount", () => {
  it("returns only the explicitly selected account to Electron, with Cancel as default", async () => {
    const choose = vi.fn(async () => ({ response: 2, checkboxChecked: false }));
    const callback = vi.fn();
    await selectPreviewWebAuthnAccount(request(), callback, choose);
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ["Cancel", "first@example.com", "second@example.com"],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(callback).toHaveBeenCalledExactlyOnceWith("private-account-b");
    expect(JSON.stringify(choose.mock.calls)).not.toContain("private-account");
  });
  it("cancels exactly once on dismiss, chooser failure, missing frame and invalid choice", async () => {
    for (const response of [0, 100]) {
      const callback = vi.fn();
      await selectPreviewWebAuthnAccount(request(), callback, async () => ({
        response,
        checkboxChecked: false,
      }));
      expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
    }
    const failed = vi.fn();
    await selectPreviewWebAuthnAccount(request(), failed, async () => {
      throw new Error("closed");
    });
    expect(failed).toHaveBeenCalledExactlyOnceWith(undefined);
    const missing = vi.fn();
    await selectPreviewWebAuthnAccount({ ...request(), frame: null }, missing);
    expect(missing).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("does not apply an account choice after the requesting frame navigates", async () => {
    const details = request();
    const frame = { url: "https://example.com/login" };
    details.frame = frame as typeof details.frame;
    const callback = vi.fn();
    await selectPreviewWebAuthnAccount(details, callback, async () => {
      frame.url = "https://other.example.com";
      return { response: 1, checkboxChecked: false };
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
