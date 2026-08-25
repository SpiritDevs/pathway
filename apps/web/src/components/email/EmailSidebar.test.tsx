import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EmailEnvironmentSelect, EmailSourceToggle } from "./EmailSidebar";
import { buildEmailSidebarProjects } from "./emailSidebar.logic";

describe("buildEmailSidebarProjects", () => {
  it("shows one project for connections on several environments", () => {
    const primaryEnvironmentId = EnvironmentId.make("env-primary");
    const projects = buildEmailSidebarProjects(
      [
        {
          id: ProjectId.make("quotecloud"),
          title: "quotecloud-v2",
          projectIds: [
            ProjectId.make("quotecloud"),
            ProjectId.make("quotecloud-local"),
            ProjectId.make("quotecloud-remote-1"),
            ProjectId.make("quotecloud-remote-2"),
          ],
          environmentProjects: [
            {
              id: ProjectId.make("quotecloud-remote-1"),
              environmentId: EnvironmentId.make("env-remote-1"),
            },
            {
              id: ProjectId.make("quotecloud-local"),
              environmentId: primaryEnvironmentId,
            },
            {
              id: ProjectId.make("quotecloud-remote-2"),
              environmentId: EnvironmentId.make("env-remote-2"),
            },
          ],
        },
      ],
      primaryEnvironmentId,
    );

    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe("quotecloud");
    expect(projects[0]?.title).toBe("quotecloud-v2");
    expect(projects[0]?.inboxProjectId).toBe("quotecloud-local");
    expect(projects[0]?.connections).toHaveLength(3);
    expect(projects[0]?.projectIds.has(ProjectId.make("quotecloud-remote-2"))).toBe(true);
  });

  it("omits projects without a connected capture inbox", () => {
    expect(
      buildEmailSidebarProjects(
        [
          {
            id: ProjectId.make("planned"),
            title: "Planned",
            projectIds: [ProjectId.make("planned")],
            environmentProjects: [],
          },
        ],
        EnvironmentId.make("env-primary"),
      ),
    ).toEqual([]);
  });
});

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
