import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SlackRouteRuleEditor, SlackRuleAutomationEditor } from "./SlackRouteRuleEditor";
import type { SlackRoutingRule } from "./slackWorkspaceWizard.logic";

const rule: SlackRoutingRule = {
  id: "rule-1",
  name: "Main",
  condition: {
    id: "group-1",
    type: "group",
    operator: "all",
    children: [{ id: "condition-1", type: "everyMessage" }],
  },
  teamId: "team-1",
  projectId: "project-1",
  cycleId: "cycle-1",
  initialPlacement: { kind: "status", statusId: "status-1" },
  investigation: {
    kind: "status",
    triggerStatusId: "status-1",
    successStatusId: "status-2",
  },
  assignment: "after-investigation",
};

const teams = [{ id: "team-1", name: "Platform" }];
const projects = [{ id: "project-1", name: "Pathway", environmentIds: ["environment-1"] }];
const statuses = [
  { id: "status-1", name: "In progress", teamId: "team-1" },
  { id: "status-2", name: "Done", teamId: "team-1" },
];
const cycles = [{ id: "cycle-1", name: "August", teamId: "team-1" }];
const noop = () => {};

describe("SlackRouteRuleEditor", () => {
  it("renders friendly labels for every routing select", () => {
    const markup = renderToStaticMarkup(
      <SlackRouteRuleEditor
        cycles={cycles}
        expanded
        index={0}
        onChange={noop}
        onDelete={noop}
        onExpandedChange={noop}
        onMove={noop}
        projects={projects}
        rule={rule}
        ruleCount={1}
        statuses={statuses}
        teams={teams}
      />,
    );

    for (const label of ["All", "Every message", "Platform", "Pathway", "In progress", "August"]) {
      expect(markup).toContain(`>${label}<`);
    }
    for (const rawValue of ["everyMessage", "team-1", "project-1", "status-1", "cycle-1"]) {
      expect(markup).not.toContain(`>${rawValue}<`);
    }
  });
});

describe("SlackRuleAutomationEditor", () => {
  it("renders friendly labels for every automation select", () => {
    const markup = renderToStaticMarkup(
      <SlackRuleAutomationEditor
        index={0}
        onChange={noop}
        projects={projects}
        rule={rule}
        statuses={statuses}
      />,
    );

    for (const label of ["When status changes", "After investigation", "In progress", "Done"]) {
      expect(markup).toContain(`>${label}<`);
    }
    for (const rawValue of ["status", "after-investigation", "status-1", "status-2"]) {
      expect(markup).not.toContain(`>${rawValue}<`);
    }
  });
});
