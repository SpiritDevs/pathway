// @effect-diagnostics nodeBuiltinImport:off -- Public RFC test material, never a production credential.
import * as NodeCrypto from "node:crypto";
/** RFC 6979 A.2.5 NIST P-256 key vector. https://www.rfc-editor.org/rfc/rfc6979#appendix-A.2.5 */
const encode = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
const publicJwk = {
  kty: "EC",
  crv: "P-256",
  x: encode("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: encode("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
};
export const appleTestPublicKey = NodeCrypto.createPublicKey({ key: publicJwk, format: "jwk" });
export const appleTestCredential = {
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  keyId: "TESTKEY001",
  privateKey: NodeCrypto.createPrivateKey({
    key: {
      ...publicJwk,
      d: encode("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721"),
    },
    format: "jwk",
  })
    .export({ format: "pem", type: "pkcs8" })
    .toString(),
};
