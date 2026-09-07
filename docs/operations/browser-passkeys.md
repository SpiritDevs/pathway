# Browser passkey signing and Apple Passwords

## Implemented desktop support

Pathway's pinned Electron 41.5.0 supports device-bound Touch ID / Secure Enclave credentials. Signed macOS artifacts now declare a dedicated keychain group, `<TEAM_ID>.com.spiritdevs.pathway.webauthn`. The packaging script places the same group in the artifact's `package.json` as `pathwayWebAuthnKeychainGroup`; the application reads that metadata at startup. Unsigned artifacts omit the field. This avoids enabling an authenticator based on an ambient environment variable or a bundle built under a different signing identity.

Preview sessions install Electron's `select-webauthn-account` handler. The user selects an account in a native dialog; cancellation, a failed dialog, or navigation cancels the original request. Credential identifiers go only to Electron's callback. OS verification remains required where the authenticator demands it.

The existing signed build configuration uses `PATHWAY_APPLE_TEAM_ID` and `PATHWAY_MACOS_PROVISIONING_PROFILE`. Ensure the profile permits the new keychain access group and that the app's signed entitlements match the generated metadata. Do not share profiles, signing material, or credentials in test evidence. Secure Enclave hardware is required for this authenticator. Electron isolates these credentials using a persistent secret per browser session, so separate Pathway browser profiles do not see one another's device-bound credentials.

Source: [Electron 41.5.0 WebAuthn API](https://github.com/electron/electron/blob/v41.5.0/docs/api/app.md#appconfigurewebauthnoptions-macos). These credentials do **not** sync through iCloud Keychain, and this implementation does not read existing Apple Passwords entries.

## Existing Apple Passwords passkeys for arbitrary websites

This remains a separate integration and an external release dependency. Apple requires the managed [`com.apple.developer.web-browser.public-key-credential` entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential) to make passkey registration and assertion requests for arbitrary relying parties. An organization Account Holder must submit the [macOS browser passkeys request](https://developer.apple.com/contact/request/macos-browsers-passkeys/). Apple evaluates whether the app qualifies as a browser, including HTTP/HTTPS scheme handling and a URL/search/bookmark entry point. Adding the entitlement to a plist without Apple's grant does not enable the capability.

After approval, implement Apple's browser-specific `ASAuthorizationWebBrowserPublicKeyCredentialManager` and browser assertion/registration requests, request the person's authorization, and use the system credential-provider sheet. The bridge must preserve Chromium's actual requesting origin, relying party, challenge, frame identity, cancellation, and WebAuthn result encoding. A normal associated-domain app request is insufficient for arbitrary websites. The native Clerk bridge implements Pathway's own sign-in and must not be repurposed as though it granted browser access.

[Apple's browser integration guidance](https://developer.apple.com/documentation/authenticationservices/authenticating-people-by-using-passkeys-in-browser-apps) covers authorization and credential selection. Electron's newer `platformPasskeys` option on its main branch still requires each website to associate its domain with Pathway through its AASA file; upgrading solely to obtain that option does not meet arbitrary-site browser requirements. No Electron upgrade or native arbitrary-site Apple bridge is included in this change.

Apple's browser passkey entitlement does not by itself implement arbitrary-site password autofill. Apple Passwords password access, Pathway's account-synced password vault, and browser cookies have separate integration and storage requirements. Do not label cookies or device-bound credentials as Apple Passwords support.

## Required release verification

Use a signed artifact and actual supported hardware to check registration, existing credential assertion, multiple-account selection, cancellation, timeout, navigation during selection, browser-profile separation, and relaunch. Inspect the built entitlements and embedded profile before testing. Record the artifact version and signing identity, but never private credentials or secret values.

For the future Apple Passwords bridge, additionally verify already-synced credentials from Safari or another device, authorization denial and revocation, correct origin handling including subdomains and iframes, and another configured system credential provider. Remote Chromium cannot acquire a local Mac or iPhone passkey merely by streaming its screen. Remote authentication must have its own supported origin-preserving handoff, and must be tested independently of desktop-local access.

Unit tests verify configuration, account callbacks, generated entitlement text, and metadata gating. They do not prove real signed-build, biometric, iCloud, or password-manager compatibility.
