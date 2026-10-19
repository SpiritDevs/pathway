/**
 * The right pane: one message under one of four tabs.
 *
 * One thing at a time, so Preview gets the full pane — which matters because the desktop device
 * size needs the room. Metadata, Deliverability, and Raw render the message's own capture record;
 * the two things the capture contract does not carry yet (extracted links, the `.eml` source) say
 * so in place rather than being faked.
 *
 * @module components/email/EmailReadingPane
 */
import type {
  CapturedEmailMessage,
  EmailDeliverabilityCheck,
  EmailProjectAttribution,
  EmailRoutingRule,
  EmailTag,
  EmailTagId,
} from "@spiritdevs/contracts";
import {
  AlertTriangleIcon,
  CheckIcon,
  MailOpenIcon,
  MonitorIcon,
  TagsIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { EmailPreviewFrame } from "./EmailPreviewFrame";
import { EmailTagChips } from "./EmailTagChips";
import {
  buildEmailPreviewDocument,
  EMAIL_READING_TABS,
  EMAIL_READING_TAB_LABELS,
  formatEmailAddressList,
  formatEmailBytes,
  formatEmailDurationMs,
  hasRemoteEmailContent,
  isTrustedEmailSender,
  hasOneOffRemoteContentPermission,
  trustedEmailSenderAddress,
  type EmailReadingTab,
} from "./emailView.logic";

const ROUTING_RULE_EXPLANATIONS: Readonly<Record<EmailRoutingRule, string>> = {
  "auth-username": "The SMTP AUTH username matched this project's mail slug.",
  "auth-password": "The SMTP AUTH password matched this project's capture password.",
  "recipient-domain": "A recipient address used this project's mail slug as its domain.",
  "recipient-plus-tag": "A recipient address carried this project's mail slug as a plus tag.",
  unassigned: "Nothing in the envelope named a project, so the message landed in Unassigned.",
};

export function EmailReadingPane({
  message,
  isPending,
  error,
  projectName,
  environmentName,
  tags,
  tagIds,
  onEditTags,
  onMarkUnread,
  trustedSenderAddresses,
  onTrustRemoteSender,
  messageIdentity,
  tab,
  onTab,
}: {
  message: CapturedEmailMessage | null;
  isPending: boolean;
  error: string | null;
  /** The attributed project's title, or null for Unassigned and for a project since removed. */
  projectName: string | null;
  /** Source environment that accepted the SMTP transaction. */
  environmentName: string | null;
  tags: ReadonlyArray<EmailTag>;
  tagIds: ReadonlyArray<EmailTagId>;
  onEditTags: () => void;
  onMarkUnread: () => void;
  /** Normalized exact addresses replicated through the active company. */
  trustedSenderAddresses: ReadonlySet<string>;
  onTrustRemoteSender: (address: string) => void;
  /** Company + environment + message identity; prevents a one-off grant crossing equal ids. */
  messageIdentity: string | null;
  tab: EmailReadingTab;
  onTab: (tab: EmailReadingTab) => void;
}) {
  // The local override makes the current click immediate while its replicated trust write lands.
  const [allowRemoteFor, setAllowRemoteFor] = useState<string | null>(null);
  const senderAddress = message === null ? null : trustedEmailSenderAddress(message);
  const allowRemote =
    message !== null &&
    messageIdentity !== null &&
    (hasOneOffRemoteContentPermission(allowRemoteFor, messageIdentity) ||
      isTrustedEmailSender(message, trustedSenderAddresses));

  const previewDocument = useMemo(
    () =>
      message === null
        ? ""
        : buildEmailPreviewDocument(message, { allowRemoteContent: allowRemote }),
    [allowRemote, message],
  );

  if (error !== null) {
    return (
      <PaneNotice title="This message could not be read">
        <p className="text-sm text-muted-foreground">{error}</p>
      </PaneNotice>
    );
  }
  if (message === null) {
    return isPending ? (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    ) : (
      <PaneNotice title="No message selected">
        <p className="text-sm text-muted-foreground">
          Pick a message on the left to read it, inspect its headers, or check how it would deliver.
        </p>
      </PaneNotice>
    );
  }

  const subject =
    message.parsedHeaders.subject === null || message.parsedHeaders.subject.trim().length === 0
      ? "(no subject)"
      : message.parsedHeaders.subject;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-start gap-3 border-b border-border/50 px-3 py-2 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-foreground">{subject}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {formatEmailAddressList(message.parsedHeaders.from, { empty: "Unknown sender" })}
            {" → "}
            {formatEmailAddressList(message.parsedHeaders.to)}
          </p>
          {environmentName === null ? null : (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <MonitorIcon aria-hidden="true" className="size-3" />
              Captured on {environmentName}
            </p>
          )}
          <div className="mt-1.5">
            <EmailTagChips tagIds={tagIds} tags={tags} />
          </div>
        </div>
        <Button onClick={onEditTags} size="xs" variant="ghost">
          <TagsIcon aria-hidden="true" />
          Tags
        </Button>
        {message.isRead ? (
          <Button onClick={onMarkUnread} size="xs" variant="ghost">
            <MailOpenIcon aria-hidden="true" />
            Mark unread
          </Button>
        ) : null}
      </div>

      <div
        aria-label="Message tabs"
        className="flex items-center gap-0.5 border-b border-border/50 px-3 py-1.5 sm:px-5"
        role="tablist"
      >
        {EMAIL_READING_TABS.map((value) => {
          const active = value === tab;
          return (
            <button
              aria-selected={active}
              className={cn(
                "h-6 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              key={value}
              onClick={() => onTab(value)}
              role="tab"
              type="button"
            >
              {EMAIL_READING_TAB_LABELS[value]}
            </button>
          );
        })}
      </div>

      {tab === "preview" ? (
        <EmailPreviewFrame
          document={previewDocument}
          onLoadRemoteContent={() => {
            if (messageIdentity !== null) setAllowRemoteFor(messageIdentity);
            if (senderAddress !== null) onTrustRemoteSender(senderAddress);
          }}
          remoteContentBlocked={!allowRemote && hasRemoteEmailContent(message.htmlBody)}
          subject={subject}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3 sm:px-5">
          {tab === "metadata" ? (
            <MetadataTab
              environmentName={environmentName}
              message={message}
              projectName={projectName}
            />
          ) : tab === "deliverability" ? (
            <DeliverabilityTab message={message} />
          ) : (
            <RawTab message={message} />
          )}
        </div>
      )}
    </div>
  );
}

function PaneNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-5">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {description === undefined ? null : (
        <p className="mb-1.5 text-xs text-muted-foreground/70">{description}</p>
      )}
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, value], index) => (
        <div className="contents" key={`${label}:${index}`}>
          <dt className="truncate text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words font-mono text-foreground/90">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function routingExplanation(attribution: EmailProjectAttribution, projectName: string | null) {
  const rule = ROUTING_RULE_EXPLANATIONS[attribution.matchedBy];
  const target = projectName ?? attribution.mailSlug ?? "Unassigned";
  return attribution.matchedValue === null
    ? rule
    : `${rule} Matched “${attribution.matchedValue}” → ${target}.`;
}

function MetadataTab({
  message,
  projectName,
  environmentName,
}: {
  message: CapturedEmailMessage;
  projectName: string | null;
  environmentName: string | null;
}) {
  const metrics = message.deliverability.metrics;
  return (
    <>
      <Section description={routingExplanation(message.attribution, projectName)} title="Routing">
        <Rows
          rows={[
            ["Environment", environmentName ?? "Unknown"],
            ["Inbox", projectName ?? message.attribution.mailSlug ?? "Unassigned"],
            ["Matched by", message.attribution.matchedBy],
            ["MAIL FROM", message.envelope.mailFrom ?? "<> (empty reverse-path)"],
            ["RCPT TO", message.envelope.rcptTo.join(", ") || "—"],
            ["AUTH username", message.envelope.authUsername ?? "—"],
            ["HELO", message.envelope.helo ?? "—"],
            ["Remote address", message.envelope.remoteAddress ?? "—"],
          ]}
        />
      </Section>

      <Section title="Headers">
        {message.parsedHeaders.headers.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">This message carried no headers.</p>
        ) : (
          <Rows
            rows={message.parsedHeaders.headers.map(
              (header) => [header.name, header.value] as const,
            )}
          />
        )}
      </Section>

      <Section title="Attachments">
        {message.attachments.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">No attachments.</p>
        ) : (
          <Rows
            rows={message.attachments.map(
              (attachment) =>
                [
                  attachment.filename ?? attachment.contentId ?? attachment.id,
                  `${attachment.contentType} · ${formatEmailBytes(attachment.sizeBytes)}`,
                ] as const,
            )}
          />
        )}
      </Section>

      <Section title="Sizes and content">
        <Rows
          rows={[
            ["Message size", formatEmailBytes(message.sizeBytes)],
            ["Subject length", `${metrics.subjectLength} characters`],
            ["Visible text", `${metrics.visibleTextCharacters} characters`],
            ["Images", `${metrics.imageCount}`],
            ["Image to text ratio", metrics.imageToTextRatio.toFixed(2)],
            // Counted rather than fired: the preview blocks remote assets, which is what makes
            // this number reportable at all.
            ["Tracking pixels", `${metrics.trackingPixelCount} (blocked in preview)`],
          ]}
        />
      </Section>

      <Section title="Timings">
        <Rows
          rows={[
            ["Connected", message.timings.connectedAt],
            ["Received", message.timings.messageReceivedAt],
            ["Parsed", message.timings.parsedAt],
            ["Stored", message.timings.storedAt],
            ["Parse duration", formatEmailDurationMs(message.timings.parseDurationMs)],
            ["Total duration", formatEmailDurationMs(message.timings.totalDurationMs)],
          ]}
        />
      </Section>

      <Section title="Links">
        <p className="text-xs text-muted-foreground/70">
          Link extraction is not part of the capture record yet, so there is nothing to list here.
        </p>
      </Section>
    </>
  );
}

const CHECK_STATUS_STYLES = {
  pass: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  fail: "text-red-600 dark:text-red-400",
} as const;

function CheckIconFor({ check }: { check: EmailDeliverabilityCheck }) {
  const className = cn("size-3.5 shrink-0", CHECK_STATUS_STYLES[check.status]);
  if (check.status === "pass") return <CheckIcon aria-hidden="true" className={className} />;
  if (check.status === "warning")
    return <AlertTriangleIcon aria-hidden="true" className={className} />;
  return <XIcon aria-hidden="true" className={className} />;
}

function DeliverabilityTab({ message }: { message: CapturedEmailMessage }) {
  const { checks, htmlCompatibilityWarnings, version } = message.deliverability;
  return (
    <>
      <Section
        description={`Offline structural checks, run at capture time (analyzer v${version}). Nothing here talks to a mail server.`}
        title="Checks"
      >
        {checks.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">This message has no recorded checks.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {checks.map((check) => (
              <li className="flex items-start gap-2" key={check.id}>
                <span className="mt-0.5">
                  <CheckIconFor check={check} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">{check.summary}</span>
                  <span className="block text-xs text-muted-foreground">{check.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="HTML compatibility">
        {htmlCompatibilityWarnings.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">
            Nothing in this message is known to break in a major client.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {htmlCompatibilityWarnings.map((warning) => (
              <li key={warning.ruleId}>
                <span className="block text-xs font-medium text-foreground">{warning.feature}</span>
                <span className="block text-xs text-muted-foreground">{warning.detail}</span>
                <span className="block text-[11px] text-muted-foreground/70">
                  Affects {warning.clients.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function RawTab({ message }: { message: CapturedEmailMessage }) {
  return (
    <>
      <Section
        description="Client lines are what the sending app wrote; server lines are what the listener answered."
        title="SMTP transaction"
      >
        {message.smtpTransactionLog.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">No transaction was recorded.</p>
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground/90">
            {message.smtpTransactionLog
              .map((entry) => `${entry.direction === "client" ? "→" : "←"} ${entry.line}`)
              .join("\n")}
          </pre>
        )}
      </Section>

      <Section title=".eml source">
        <p className="text-xs text-muted-foreground/70">
          The capture record keeps the parsed message rather than its bytes, so there is no source
          to show yet.
        </p>
      </Section>
    </>
  );
}
