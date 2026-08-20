import { EnvironmentId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EmailEnvironmentSelect, EmailSourceToggle } from "./EmailSidebar";

describe("EmailEnvironmentSelect", () => {
  const primaryEnvironmentId = EnvironmentId.make("env-primary");
  const browserEnvironmentId = EnvironmentId.make("env-browser");
  const environments = [
    { environmentId: primaryEnvironmentId, label: "Corey's Mac Studio" },
    { environmentId: browserEnvironmentId, label: "M1 Dev Browser" },
  ];

  it("shows all environments as the default compact selection", () => {
    const markup = renderToStaticMarkup(
      <EmailEnvironmentSelect
        environmentId={null}
        environments={environments}
        onEnvironmentChange={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Filter email by environment"');
    expect(markup).toContain("All environments");
    expect(markup).toContain("w-full");
  });

  it("shows the selected environment", () => {
    const markup = renderToStaticMarkup(
      <EmailEnvironmentSelect
        environmentId={browserEnvironmentId}
        environments={environments}
        onEnvironmentChange={() => {}}
      />,
    );

    expect(markup).toContain("M1 Dev Browser");
    expect(markup).not.toContain(">All environments</span></button>");
  });
});

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
