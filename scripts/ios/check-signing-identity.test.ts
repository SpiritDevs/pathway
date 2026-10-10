import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { hasDevelopmentIdentity } from "./check-signing-identity.ts";

function certificate(commonName: string, teamID: string) {
  return NodeChildProcess.execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      "/dev/null",
      "-days",
      "1",
      "-subj",
      `/CN=${commonName}/OU=${teamID}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
}

function identity(pem: string) {
  const cert = new NodeCrypto.X509Certificate(pem);
  return `  1) ${cert.fingerprint.replaceAll(":", "")} "Apple Development: Test User (PERSONALID)"\n     1 valid identities found`;
}

describe("iOS signing identity validation", () => {
  const pem = certificate("Apple Development: Test User (PERSONALID)", "TEAM123456");

  it("accepts the certificate team when the display name contains a personal identifier", () => {
    expect(hasDevelopmentIdentity(identity(pem), pem, "TEAM123456")).toBe(true);
  });

  it("rejects a certificate for another team", () => {
    expect(hasDevelopmentIdentity(identity(pem), pem, "OTHER12345")).toBe(false);
  });

  it("rejects certificates without a valid private-key signing identity", () => {
    expect(hasDevelopmentIdentity("0 valid identities found", pem, "TEAM123456")).toBe(false);
    const other = certificate("Apple Development: Another User", "TEAM123456");
    expect(hasDevelopmentIdentity(identity(other), pem, "TEAM123456")).toBe(false);
  });

  it("rejects distribution identities even on the correct team", () => {
    const distribution = certificate("Apple Distribution: Test User", "TEAM123456");
    expect(hasDevelopmentIdentity(identity(distribution), distribution, "TEAM123456")).toBe(false);
  });
});
