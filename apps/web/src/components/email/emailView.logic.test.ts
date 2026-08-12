import type { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildEmailPreviewDocument,
  clampEmailPreviewWidth,
  DEFAULT_EMAIL_PREVIEW_WIDTH,
  EMAIL_DEVICE_PRESETS,
  EMAIL_PREVIEW_SANDBOX,
  emailPresetForWidth,
  emailScopeFromParam,
  emailScopeParam,
  formatEmailAddressList,
  formatEmailBytes,
  formatEmailDurationMs,
  formatEmailTimestamp,
  hasRemoteEmailContent,
  MAX_EMAIL_PREVIEW_WIDTH,
  MIN_EMAIL_PREVIEW_WIDTH,
  parseEmailSearch,
} from "./emailView.logic";

describe("parseEmailSearch", () => {
  it("keeps every param it recognises", () => {
    expect(
      parseEmailSearch({ inbox: "unassigned", message: "msg_1", tab: "raw", analytics: "true" }),
    ).toEqual({ inbox: "unassigned", message: "msg_1", tab: "raw", analytics: true });
  });

  it("drops an unknown tab rather than rendering an empty pane", () => {
    expect(parseEmailSearch({ tab: "attachments" }).tab).toBeUndefined();
  });

  it("treats blank and missing params the same", () => {
    expect(parseEmailSearch({ inbox: "   ", message: "" })).toEqual({
      inbox: undefined,
      message: undefined,
      tab: undefined,
      analytics: undefined,
    });
  });

  it("writes analytics as absent rather than false", () => {
    expect(parseEmailSearch({ analytics: false }).analytics).toBeUndefined();
  });
});

describe("email scope params", () => {
  it("round-trips every scope", () => {
    const projectId = "prj_123" as ProjectId;
    expect(emailScopeParam({ type: "all" })).toBeUndefined();
    expect(emailScopeParam({ type: "unassigned" })).toBe("unassigned");
    expect(emailScopeParam({ type: "project", projectId })).toBe("prj_123");
    expect(emailScopeFromParam(undefined)).toEqual({ type: "all" });
    expect(emailScopeFromParam("all")).toEqual({ type: "all" });
    expect(emailScopeFromParam("unassigned")).toEqual({ type: "unassigned" });
    expect(emailScopeFromParam("prj_123")).toEqual({ type: "project", projectId });
  });
});

describe("device sizes", () => {
  it("offers the three email-shaped presets rather than device hardware", () => {
    expect(EMAIL_DEVICE_PRESETS.map((preset) => [preset.label, preset.width])).toEqual([
      ["Desktop", 1000],
      ["Tablet", 768],
      ["Mobile", 375],
    ]);
  });

  it("clamps a drag to a width a mail client could have", () => {
    expect(clampEmailPreviewWidth(10)).toBe(MIN_EMAIL_PREVIEW_WIDTH);
    expect(clampEmailPreviewWidth(99_999)).toBe(MAX_EMAIL_PREVIEW_WIDTH);
    expect(clampEmailPreviewWidth(600.4)).toBe(600);
    expect(clampEmailPreviewWidth(Number.NaN)).toBe(DEFAULT_EMAIL_PREVIEW_WIDTH);
  });

  it("lights a preset only on an exact match, so a freeform width reads as custom", () => {
    expect(emailPresetForWidth(768)).toBe("tablet");
    expect(emailPresetForWidth(769)).toBeNull();
  });
});

describe("buildEmailPreviewDocument", () => {
  const html = '<p>Hi</p><img src="https://tracker.example/pixel.gif">';

  it("renders in a fully sandboxed frame", () => {
    expect(EMAIL_PREVIEW_SANDBOX).toBe("");
  });

  it("blocks remote images and stylesheets by default", () => {
    const document = buildEmailPreviewDocument(
      { htmlBody: html, textBody: null },
      { allowRemoteContent: false },
    );
    expect(document).toContain("img-src data: cid:;");
    expect(document).not.toContain("img-src data: cid: https:");
    expect(document).toContain("style-src 'unsafe-inline';");
    expect(document).toContain(html);
  });

  it("opens images, styles, and fonts on request and nothing else", () => {
    const document = buildEmailPreviewDocument(
      { htmlBody: html, textBody: null },
      { allowRemoteContent: true },
    );
    expect(document).toContain("img-src data: cid: https: http:");
    expect(document).toContain("style-src 'unsafe-inline' https: http:");
    expect(document).toContain("font-src data: https: http:");
  });

  it("never allows scripts, objects, frames, or form posts at either setting", () => {
    for (const allowRemoteContent of [false, true]) {
      const document = buildEmailPreviewDocument(
        { htmlBody: html, textBody: null },
        { allowRemoteContent },
      );
      expect(document).toContain("default-src 'none'");
      expect(document).toContain("script-src 'none'");
      expect(document).toContain("object-src 'none'");
      expect(document).toContain("frame-src 'none'");
      expect(document).toContain("form-action 'none'");
      expect(document).toContain("base-uri 'none'");
    }
  });

  it("escapes a text-only body so markup in it is read rather than rendered", () => {
    const document = buildEmailPreviewDocument(
      { htmlBody: null, textBody: "<b>code</b> 123456" },
      { allowRemoteContent: false },
    );
    expect(document).toContain("&lt;b&gt;code&lt;/b&gt; 123456");
    expect(document).not.toContain("<b>code</b>");
  });

  it("prefers HTML when the message carries both, the way a real client would", () => {
    const document = buildEmailPreviewDocument(
      { htmlBody: "<p>rich</p>", textBody: "plain" },
      { allowRemoteContent: false },
    );
    expect(document).toContain("<p>rich</p>");
    expect(document).not.toContain(">plain<");
  });

  it("says so rather than rendering a blank frame for an empty message", () => {
    const document = buildEmailPreviewDocument(
      { htmlBody: "   ", textBody: null },
      { allowRemoteContent: false },
    );
    expect(document).toContain("This message has no body.");
  });
});

describe("hasRemoteEmailContent", () => {
  it("spots the references that decide whether the blocked banner is worth showing", () => {
    expect(hasRemoteEmailContent('<img src="https://a.example/p.gif">')).toBe(true);
    expect(hasRemoteEmailContent('<img src="//a.example/p.gif">')).toBe(true);
    expect(hasRemoteEmailContent('<link rel="stylesheet" href="http://a.example/s.css">')).toBe(
      true,
    );
    expect(hasRemoteEmailContent('<div style="background:url(https://a.example/b.png)">')).toBe(
      true,
    );
  });

  it("stays quiet for a message that asks for nothing off the machine", () => {
    expect(hasRemoteEmailContent('<img src="data:image/gif;base64,AA==">')).toBe(false);
    expect(hasRemoteEmailContent('<img src="cid:logo">')).toBe(false);
    expect(hasRemoteEmailContent(null)).toBe(false);
  });
});

describe("formatting", () => {
  it("names an address with its display name when it has one", () => {
    expect(
      formatEmailAddressList([
        { address: "a@example.com", name: "Ada" },
        { address: "b@example.com", name: null },
      ]),
    ).toBe("Ada <a@example.com>, b@example.com");
    expect(formatEmailAddressList([])).toBe("—");
    expect(formatEmailAddressList([], { empty: "Unknown sender" })).toBe("Unknown sender");
  });

  it("sizes a message the way a mail client does", () => {
    expect(formatEmailBytes(0)).toBe("0 B");
    expect(formatEmailBytes(1536)).toBe("1.5 KB");
    expect(formatEmailBytes(-1)).toBe("—");
  });

  it("reports a capture duration in the unit it happened in", () => {
    expect(formatEmailDurationMs(12)).toBe("12 ms");
    expect(formatEmailDurationMs(1450)).toBe("1.5 s");
  });

  // Built from local components rather than from UTC strings: "today" is a local-calendar
  // question, so a UTC literal would flip the assertion for anyone west of Greenwich.
  it("shows the clock for today, the date for this year, and the year for anything older", () => {
    const now = new Date(2026, 7, 12, 15, 0);
    expect(formatEmailTimestamp(new Date(2026, 7, 12, 9, 5).toISOString(), now)).toBe("09:05");
    expect(formatEmailTimestamp(new Date(2026, 2, 2, 9, 5).toISOString(), now)).toBe("Mar 02");
    expect(formatEmailTimestamp(new Date(2024, 2, 2, 9, 5).toISOString(), now)).toBe(
      "Mar 02, 2024",
    );
    expect(formatEmailTimestamp("not a date", now)).toBe("—");
  });
});
