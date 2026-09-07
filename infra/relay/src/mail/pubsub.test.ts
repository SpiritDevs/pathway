import { it, expect } from "vite-plus/test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyPubsubToken } from "./routes.ts";
it("verifies Google push signature, issuer, audience and service account", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "fixture" }] });
  const issue = (email: string, verified = true) =>
    new SignJWT({ email, email_verified: verified })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer("https://accounts.google.com")
      .setAudience("https://relay.test/v1/mail/notify")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(privateKey);
  await expect(
    verifyPubsubToken(
      await issue("push@example.com"),
      "https://relay.test/v1/mail/notify",
      "push@example.com",
      jwks,
    ),
  ).resolves.toBeUndefined();
  await expect(
    verifyPubsubToken(
      await issue("other@example.com"),
      "https://relay.test/v1/mail/notify",
      "push@example.com",
      jwks,
    ),
  ).rejects.toThrow();
  await expect(
    verifyPubsubToken(
      await issue("push@example.com", false),
      "https://relay.test/v1/mail/notify",
      "push@example.com",
      jwks,
    ),
  ).rejects.toThrow();
  await expect(
    verifyPubsubToken(
      await issue("push@example.com"),
      "https://other.test/v1/mail/notify",
      "push@example.com",
      jwks,
    ),
  ).rejects.toThrow();
});
