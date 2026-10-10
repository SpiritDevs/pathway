import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

export function hasDevelopmentIdentity(identities: string, certificates: string, teamID: string) {
  const validFingerprints = new Set(
    Array.from(identities.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"/gm), (match) =>
      match[1]!.toUpperCase(),
    ),
  );
  return Array.from(
    certificates.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g),
  ).some(([pem]) => {
    const certificate = new NodeCrypto.X509Certificate(pem);
    const subject = certificate.subject.split("\n");
    return (
      subject.some((field) => field.startsWith("CN=Apple Development:")) &&
      subject.includes(`OU=${teamID}`) &&
      validFingerprints.has(certificate.fingerprint.replaceAll(":", "").toUpperCase())
    );
  });
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const [keychain, teamID] = process.argv.slice(2);
  if (!keychain || !teamID) throw new Error("Expected signing keychain and Apple Team ID.");
  const identities = NodeChildProcess.execFileSync(
    "security",
    ["find-identity", "-v", "-p", "codesigning", keychain],
    {
      encoding: "utf8",
    },
  );
  const certificates = NodeChildProcess.execFileSync(
    "security",
    ["find-certificate", "-a", "-p", keychain],
    {
      encoding: "utf8",
    },
  );
  if (!hasDevelopmentIdentity(identities, certificates, teamID)) {
    console.error(
      "The signing certificate must include an Apple Development private key for APPLE_TEAM_ID.",
    );
    process.exitCode = 1;
  }
}
