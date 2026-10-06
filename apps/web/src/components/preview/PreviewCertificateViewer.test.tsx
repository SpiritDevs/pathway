import type { DesktopPreviewCertificate } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CertificateDetails,
  CertificateGeneral,
  certificateName,
  formatCertificateDate,
  formatDistinguishedName,
  formatFingerprint,
} from "./PreviewCertificateViewer";

const certificate = (
  overrides: Partial<DesktopPreviewCertificate> & Pick<DesktopPreviewCertificate, "subject">,
): DesktopPreviewCertificate => ({
  issuer: { organizations: [], organizationUnits: [] },
  serialNumber: "01",
  validStart: 1_788_000_000,
  validExpiry: 1_795_000_000,
  fingerprintSha256: "00".repeat(32),
  publicKeySha256: "11".repeat(32),
  subjectAlternativeNames: [],
  signatureAlgorithm: "SHA256-RSA",
  publicKeyAlgorithm: "RSA",
  ...overrides,
});

/** google.com's chain as Chromium reports it: leaf first. */
const chain: ReadonlyArray<DesktopPreviewCertificate> = [
  certificate({
    subject: { commonName: "*.google.com", organizations: [], organizationUnits: [] },
    issuer: {
      commonName: "WR2",
      organizations: ["Google Trust Services"],
      organizationUnits: [],
      country: "US",
    },
    serialNumber: "5A:3B:9C",
    fingerprintSha256: "ab".repeat(32),
    publicKeySha256: "cd".repeat(32),
    subjectAlternativeNames: ["*.google.com", "google.com"],
    publicKeyAlgorithm: "ECDSA P-256",
  }),
  certificate({
    subject: {
      commonName: "WR2",
      organizations: ["Google Trust Services"],
      organizationUnits: [],
      country: "US",
    },
    issuer: {
      commonName: "GTS Root R1",
      organizations: ["Google Trust Services LLC"],
      organizationUnits: [],
      country: "US",
    },
    serialNumber: "7F:00:01",
  }),
  certificate({
    subject: {
      commonName: "GTS Root R1",
      organizations: ["Google Trust Services LLC"],
      organizationUnits: [],
      country: "US",
    },
    issuer: {
      commonName: "GTS Root R1",
      organizations: ["Google Trust Services LLC"],
      organizationUnits: [],
      country: "US",
    },
    serialNumber: "6E:47:A9",
  }),
];
const [leaf] = chain as [DesktopPreviewCertificate, ...DesktopPreviewCertificate[]];

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("certificate formatting", () => {
  it("names a certificate the way Chrome does", () => {
    expect(certificateName(leaf)).toBe("*.google.com");
    expect(
      certificateName(
        certificate({
          subject: { organizations: [], organizationUnits: [] },
          subjectAlternativeNames: ["example.com"],
        }),
      ),
    ).toBe("example.com");
  });

  it("writes distinguished names as Chrome's Details tab does", () => {
    expect(formatDistinguishedName(leaf.issuer)).toBe(
      "CN = WR2, O = Google Trust Services, C = US",
    );
  });

  it("splits hex fingerprints into bytes and leaves other forms alone", () => {
    expect(formatFingerprint("ABCD01")).toBe("ab cd 01");
    expect(formatFingerprint("sha256/AbC=")).toBe("sha256/AbC=");
  });
});

describe("CertificateGeneral", () => {
  it("shows who the certificate was issued to and by, when, and its fingerprints", () => {
    const markup = renderToStaticMarkup(<CertificateGeneral certificate={leaf} />);

    for (const text of [
      "Issued To",
      "*.google.com",
      "Issued By",
      "Google Trust Services",
      "Validity Period",
      formatCertificateDate(leaf.validStart),
      formatCertificateDate(leaf.validExpiry),
      "SHA-256 Fingerprints",
      formatFingerprint(leaf.fingerprintSha256),
      formatFingerprint(leaf.publicKeySha256),
    ]) {
      expect(markup).toContain(text);
    }
    // The leaf has no organization of its own, which Chrome spells out.
    expect(markup).toContain("&lt;Not part of certificate&gt;");
  });
});

describe("CertificateDetails", () => {
  it("lists the chain from its root and shows the selected certificate's fields", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<CertificateDetails chain={chain} />);
    });
    const root = renderer!.root;
    const hierarchy = () =>
      root.findAll((node) => node.type === "button" && node.props["aria-pressed"] !== undefined);
    const text = () => JSON.stringify(renderer!.toJSON());

    expect(hierarchy().map((button) => button.props.children)).toEqual([
      "GTS Root R1",
      "WR2",
      "*.google.com",
    ]);
    expect(hierarchy().map((button) => button.props["aria-pressed"])).toEqual([false, false, true]);
    expect(text()).toContain("5A:3B:9C");
    expect(text()).toContain("google.com");

    await act(async () => hierarchy()[0]!.props.onClick());

    expect(hierarchy().map((button) => button.props["aria-pressed"])).toEqual([true, false, false]);
    expect(text()).toContain("6E:47:A9");
    expect(text()).not.toContain("5A:3B:9C");
  });
});
