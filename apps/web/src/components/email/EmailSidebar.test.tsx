import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EmailSourceToggle } from "./EmailSidebar";

describe("EmailSourceToggle", () => {
  it("offers Local SMTP and Gmail with the selected source pressed", () => {
    const markup = renderToStaticMarkup(
      <EmailSourceToggle onSource={() => {}} source="local-smtp" />,
    );

    expect(markup).toContain('aria-label="Email source"');
    expect(markup).toContain("Local SMTP");
    expect(markup).toContain("Gmail");
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Local SMTP<\/button>/);
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Gmail<\/button>/);
    expect(markup).toContain("rounded-full");
    expect(markup).toContain("bg-sidebar-foreground/10");
    expect(markup).toContain("bg-white");
    expect(markup).toContain("transition-transform");
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain("data-pressed:bg-transparent");
    expect(markup).toContain("data-pressed:text-zinc-950");
  });

  it("slides the indicator to the Gmail half when Gmail is the source", () => {
    const markup = renderToStaticMarkup(<EmailSourceToggle onSource={() => {}} source="gmail" />);

    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Gmail<\/button>/);
    expect(markup).toContain("translate-x-full");
  });
});
