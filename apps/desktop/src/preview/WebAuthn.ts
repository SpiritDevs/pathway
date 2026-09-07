import { dialog, type Session, type SelectWebauthnAccountDetails } from "electron";

/** Account choice stays on the browser host; only Electron receives credential IDs. */
export async function selectPreviewWebAuthnAccount(
  details: SelectWebauthnAccountDetails,
  callback: (credentialId?: string | null) => void,
  choose = dialog.showMessageBox,
): Promise<void> {
  let selected: string | undefined;
  try {
    const frame = details.frame;
    if (!frame || details.accounts.length === 0) return;
    const requestUrl = frame.url;
    const { response } = await choose({
      type: "question",
      title: "Sign in with a passkey",
      message: `Choose an account for ${details.relyingPartyId}`,
      detail:
        "This website is requesting a passkey from this browser profile. Your device may ask you to verify your identity next.",
      buttons: [
        "Cancel",
        ...details.accounts.map((account, index) =>
          (account.name || account.displayName || `Account ${index + 1}`)
            .replace(/[\r\n\t]/g, " ")
            .slice(0, 120),
        ),
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    // A navigation while the chooser was open invalidates its account choice.
    if (frame.url === requestUrl && response > 0) {
      selected = details.accounts[response - 1]?.credentialId;
    }
  } catch {
    // Closing the frame or chooser cancels the original WebAuthn request.
  } finally {
    callback(selected);
  }
}

export function installPreviewWebAuthnAccountPicker(browserSession: Session): void {
  browserSession.on("select-webauthn-account", (_event, details, callback) => {
    void selectPreviewWebAuthnAccount(details, callback);
  });
}
