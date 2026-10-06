import type {
  DesktopPreviewCertificate,
  DesktopPreviewCertificateName,
} from "@spiritdevs/contracts";
import { type ReactNode, useState } from "react";

import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

const NOT_IN_CERTIFICATE = "<Not part of certificate>";

/** What Chrome calls a certificate: its subject's common name, else its first other name. */
export function certificateName(certificate: DesktopPreviewCertificate): string {
  return (
    certificate.subject.commonName ??
    certificate.subjectAlternativeNames[0] ??
    certificate.subject.organizations[0] ??
    "Certificate"
  );
}

/** `CN = WR2, O = Google Trust Services, C = US`, as Chrome's Details tab shows a name. */
export function formatDistinguishedName(name: DesktopPreviewCertificateName): string {
  const parts: ReadonlyArray<readonly [string, ReadonlyArray<string | undefined>]> = [
    ["CN", [name.commonName]],
    ["OU", name.organizationUnits],
    ["O", name.organizations],
    ["L", [name.locality]],
    ["ST", [name.state]],
    ["C", [name.country]],
  ];
  return parts
    .flatMap(([key, values]) => values.flatMap((value) => (value ? [`${key} = ${value}`] : [])))
    .join(", ");
}

/** A hex digest in byte pairs, as Chrome shows fingerprints. Anything else shows as given. */
export function formatFingerprint(value: string): string {
  return /^(?:[\da-f]{2})+$/i.test(value)
    ? (value.toLowerCase().match(/../g) ?? []).join(" ")
    : value;
}

/** Certificate validity times are Unix seconds. */
export function formatCertificateDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  });
}

function FieldList({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {children}
    </dl>
  );
}

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-xs leading-5 break-all")}>
        {children}
      </dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function NameFields({ name }: { name: DesktopPreviewCertificateName }) {
  return (
    <FieldList>
      <Field label="Common Name (CN)">{name.commonName ?? NOT_IN_CERTIFICATE}</Field>
      <Field label="Organization (O)">{name.organizations.join(", ") || NOT_IN_CERTIFICATE}</Field>
      <Field label="Organizational Unit (OU)">
        {name.organizationUnits.join(", ") || NOT_IN_CERTIFICATE}
      </Field>
    </FieldList>
  );
}

/** The General tab: who the site's certificate was issued to and by, and its fingerprints. */
export function CertificateGeneral({ certificate }: { certificate: DesktopPreviewCertificate }) {
  return (
    <div className="flex flex-col gap-5">
      <Section title="Issued To">
        <NameFields name={certificate.subject} />
      </Section>
      <Section title="Issued By">
        <NameFields name={certificate.issuer} />
      </Section>
      <Section title="Validity Period">
        <FieldList>
          <Field label="Issued On">{formatCertificateDate(certificate.validStart)}</Field>
          <Field label="Expires On">{formatCertificateDate(certificate.validExpiry)}</Field>
        </FieldList>
      </Section>
      <Section title="SHA-256 Fingerprints">
        <FieldList>
          <Field label="Certificate" mono>
            {formatFingerprint(certificate.fingerprintSha256)}
          </Field>
          <Field label="Public Key" mono>
            {formatFingerprint(certificate.publicKeySha256)}
          </Field>
        </FieldList>
      </Section>
    </div>
  );
}

/** The Details tab: the chain from its root down, and the selected certificate's fields. */
export function CertificateDetails({ chain }: { chain: ReadonlyArray<DesktopPreviewCertificate> }) {
  // The chain arrives leaf first; Chrome lists it root first, with the site's own certificate last.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = chain[selectedIndex] ?? chain[0];
  if (!selected) return null;
  return (
    <div className="flex flex-col gap-5">
      <Section title="Certificate Hierarchy">
        <div className="flex flex-col gap-0.5" role="group" aria-label="Certificate hierarchy">
          {chain
            .map((certificate, index) => ({ certificate, index }))
            .toReversed()
            .map(({ certificate, index }, depth) => (
              <button
                key={index}
                type="button"
                aria-pressed={index === selectedIndex}
                onClick={() => setSelectedIndex(index)}
                style={{ paddingInlineStart: `${0.5 + depth * 0.875}rem` }}
                className={cn(
                  "h-7 truncate rounded-md pe-2 text-left text-sm hover:bg-accent",
                  index === selectedIndex && "bg-accent font-medium",
                )}
              >
                {certificateName(certificate)}
              </button>
            ))}
        </div>
      </Section>
      <Section title="Certificate Fields">
        <FieldList>
          <Field label="Subject">{formatDistinguishedName(selected.subject)}</Field>
          <Field label="Issuer">{formatDistinguishedName(selected.issuer)}</Field>
          <Field label="Serial Number" mono>
            {selected.serialNumber}
          </Field>
          <Field label="Not Valid Before">{formatCertificateDate(selected.validStart)}</Field>
          <Field label="Not Valid After">{formatCertificateDate(selected.validExpiry)}</Field>
          <Field label="Signature Algorithm">{selected.signatureAlgorithm}</Field>
          <Field label="Public Key Algorithm">{selected.publicKeyAlgorithm}</Field>
          {selected.subjectAlternativeNames.length > 0 ? (
            <Field label="Subject Alternative Names">
              {selected.subjectAlternativeNames.map((name) => (
                <div key={name}>{name}</div>
              ))}
            </Field>
          ) : null}
          <Field label="SHA-256 Fingerprint" mono>
            {formatFingerprint(selected.fingerprintSha256)}
          </Field>
          <Field label="Public Key SHA-256" mono>
            {formatFingerprint(selected.publicKeySha256)}
          </Field>
        </FieldList>
      </Section>
    </div>
  );
}

type CertificateTab = "general" | "details";

const TABS: ReadonlyArray<{ readonly id: CertificateTab; readonly label: string }> = [
  { id: "general", label: "General" },
  { id: "details", label: "Details" },
];

/** Chrome's certificate viewer for the site's chain, which arrives leaf first. */
export function PreviewCertificateViewer({
  chain,
  open,
  onOpenChange,
}: {
  chain: ReadonlyArray<DesktopPreviewCertificate>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<CertificateTab>("general");
  const leaf = chain[0];
  if (!leaf) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setTab("general");
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="pe-8 text-base leading-snug break-words">
            Certificate Viewer: {certificateName(leaf)}
          </DialogTitle>
        </DialogHeader>
        <div className="flex border-b px-5" role="tablist" aria-label="Certificate">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`certificate-${id}-tab`}
              aria-controls={`certificate-${id}-panel`}
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "relative h-9 px-2 text-sm text-muted-foreground outline-none after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                tab === id && "text-foreground after:bg-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <DialogPanel
          role="tabpanel"
          id={`certificate-${tab}-panel`}
          aria-labelledby={`certificate-${tab}-tab`}
        >
          <div className="pt-4">
            {tab === "general" ? (
              <CertificateGeneral certificate={leaf} />
            ) : (
              <CertificateDetails chain={chain} />
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
