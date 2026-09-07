import { describe, expect, it, vi } from "vite-plus/test";
import { dialog, type Session, type SelectWebauthnAccountDetails } from "electron";
vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));
import { installPreviewWebAuthnAccountPicker, selectPreviewWebAuthnAccount } from "./WebAuthn.ts";

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
  it("prevents Electron's default choice synchronously before awaiting the account picker", async () => {
    let listener:
      | ((
          event: { preventDefault: () => void },
          details: SelectWebauthnAccountDetails,
          callback: (id?: string | null) => void,
        ) => void)
      | undefined;
    const session = {
      on: vi.fn((_name: string, handler: NonNullable<typeof listener>) => {
        listener = handler;
      }),
    };
    const choice = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
    vi.mocked(dialog.showMessageBox).mockReturnValueOnce(choice.promise);
    installPreviewWebAuthnAccountPicker(session as unknown as Session);
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    listener!(event, request(), callback);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.preventDefault.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dialog.showMessageBox).mock.invocationCallOrder[0]!,
    );
    expect(callback).not.toHaveBeenCalled();
    choice.resolve({ response: 2, checkboxChecked: false });
    await choice.promise;
    expect(callback).toHaveBeenCalledExactlyOnceWith("private-account-b");
  });
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
