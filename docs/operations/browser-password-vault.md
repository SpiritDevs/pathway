# Browser password vault

The password vault belongs to the signed-in Pathway account. It is separate from company data, environment credentials, and agent tools. Settings → General → Passwords manages logins. The browser's Saved logins picker shows matching website accounts and fills the selected login without submitting the form.

## Deployment setup

Set these variables in the Convex deployment before saving passwords:

- `PATHWAY_BROWSER_PASSWORD_ACTIVE_KEY_ID`: the active key's identifier, such as `v1`.
- `PATHWAY_BROWSER_PASSWORD_KEYS`: a JSON object mapping key identifiers to base64-encoded 32-byte keys.

Generate a key using `openssl rand -base64 32`. Store the value in the deployment's secret configuration. Do not commit it. The JSON shape is `{"v1":"<base64 key>"}`. When using a dotenv file, wrap that JSON in single quotes; do not double-escape its inner quotes. Verify the deployed value parses as a JSON object before testing a save. Deploy the updated Convex schema and `browserPasswords` functions. An unset or invalid keyring prevents password writes; there is no plaintext fallback.

## Storage and access

Passwords use AES-256-GCM with a fresh IV per write. Authentication data binds the ciphertext to its purpose, owner, credential identifier, and exact website origin. Account metadata contains the label, origin, and username. Metadata queries return no password or ciphertext.

The authenticated owner can add, replace, delete, or explicitly unlock a selected login for its saved origin. Revision checks prevent a stale device from replacing or deleting a newer edit. Environment identities and other accounts cannot read the vault. Passwords do not enter company replication or conversation messages.

This is server encryption, not end-to-end encryption. Deployment operators with the encryption keys and database access can decrypt stored passwords. Keep previous keys in the keyring during rotation so existing records remain readable. New writes use the active key; replacing an entry encrypts it with that key.

Passkey private keys remain with their authenticator. This vault stores website passwords only. Device-bound Touch ID credentials are separate from Apple Passwords and iCloud-synced passkeys. Existing Apple Passwords entries are not yet available through this integration; see [Apple browser requirements](browser-passkeys.md). A page filled with a selected password is visible to the agent's browser tools, so the vault's metadata-only API is not a claim that page scripts cannot inspect form values.

## Verification

The focused backend tests cover ciphertext storage, owner and environment access checks, exact-origin unlock, stale revisions, deletion, missing encryption configuration, fresh IVs, and authentication-data tampering. A deployment must be updated before account sync or autofill can be verified against that deployment.
