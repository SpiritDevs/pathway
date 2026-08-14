import type { CapturedEmailSummary, EmailMessageId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EmailDetectedCodeButton, EmailMessageRow } from "./EmailMessageList";

const MESSAGE = {
  id: "msg_1" as EmailMessageId,
  attribution: {
    projectId: null,
    mailSlug: null,
    matchedBy: "unassigned",
    matchedValue: null,
  },
  from: [{ name: "QuoteCloud", address: "no-reply@quotecloud.test" }],
  to: [{ name: null, address: "tester@example.test" }],
  subject: "Authorize your QuoteCloud admin session",
  textPreview: "Your QuoteCloud authorization code is ready.",
  receivedAt: "2026-08-13T11:49:00.000Z",
  sizeBytes: 2048,
  attachmentCount: 0,
  isRead: false,
  detectedCode: "4JJVYX",
} as unknown as CapturedEmailSummary;

function renderRow(overrides?: {
  message?: CapturedEmailSummary;
  checked?: boolean;
  selected?: boolean;
  selectionCount?: number;
  selectionUnreadCount?: number;
}) {
  return renderToStaticMarkup(
    <EmailMessageRow
      checked={overrides?.checked ?? false}
      message={overrides?.message ?? MESSAGE}
      now={new Date("2026-08-13T12:00:00.000Z")}
      onAction={() => {}}
      onContextMenu={() => {}}
      onSelect={() => {}}
      onToggleSelect={() => {}}
      selected={overrides?.selected ?? false}
      selectionCount={overrides?.selectionCount ?? 0}
      selectionUnreadCount={overrides?.selectionUnreadCount ?? 0}
    />,
  );
}

describe("EmailMessageRow", () => {
  it("keeps opening and checking as two separately labelled controls", () => {
    const markup = renderRow();

    expect(markup).toContain('aria-label="Open Authorize your QuoteCloud admin session"');
    expect(markup).toContain('aria-label="Select Authorize your QuoteCloud admin session"');
    expect(markup).toContain('aria-label="Actions for Authorize your QuoteCloud admin session"');
  });

  it("hides the checkbox and the action menu until the row is hovered or focused", () => {
    const markup = renderRow();

    expect(markup).toMatch(
      /aria-label="Select [^"]*"[^>]*class="[^"]*opacity-0 group-hover:opacity-100 group-focus-within:opacity-100/,
    );
    expect(markup).toMatch(
      /class="[^"]*opacity-0[^"]*group-focus-within:opacity-100[^"]*aria-expanded:opacity-100/,
    );
  });

  it("pins the checkbox on and marks the row once it is checked", () => {
    const markup = renderRow({ checked: true });

    expect(markup).toContain('data-checked="true"');
    expect(markup).toContain("bg-primary/10");
    expect(markup).not.toMatch(/aria-label="Select [^"]*"[^>]*class="[^"]*opacity-0/);
  });

  it("keeps the open row's own highlight when it is also checked", () => {
    const markup = renderRow({ checked: true, selected: true });

    expect(markup).toContain("bg-accent/60");
    expect(markup).toContain('aria-current="true"');
  });

  it("labels a subject-less message rather than leaving the controls unnamed", () => {
    const markup = renderRow({ message: { ...MESSAGE, subject: null } as CapturedEmailSummary });

    expect(markup).toContain('aria-label="Open (no subject)"');
    expect(markup).toContain('aria-label="Select (no subject)"');
  });

  it("still surfaces the detected code and the attachment count", () => {
    const markup = renderRow({
      message: { ...MESSAGE, attachmentCount: 3 } as CapturedEmailSummary,
    });

    expect(markup).toContain('aria-label="3 attachments"');
    expect(markup).toContain("4JJVYX");
  });
});

describe("EmailDetectedCodeButton", () => {
  it("exposes a detected code as a clipboard action", () => {
    const markup = renderToStaticMarkup(<EmailDetectedCodeButton code="4JJVYX" />);

    expect(markup).toMatch(/<button[^>]*aria-label="Copy verification code 4JJVYX"/);
    expect(markup).toContain('title="Copy verification code"');
    expect(markup).toContain("4JJVYX");
  });
});
