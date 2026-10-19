// The access policy and autonomy selects write `ServerSettingsPatch.computer`,
// which a server from before the policy shipped decodes as an empty patch and
// acknowledges. The section is rendered to static markup with its data
// sources stubbed, so the gate is read from what an admin would see.

import { EnvironmentId } from "@spiritdevs/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@spiritdevs/contracts/settings";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const server = vi.hoisted(() => ({
  capabilities: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_environmentId: unknown, select: (settings: unknown) => unknown) =>
    select(DEFAULT_UNIFIED_SETTINGS),
  useUpdateEnvironmentSettings: () => () => undefined,
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () =>
    new Map(
      server.capabilities === undefined
        ? []
        : [[ENVIRONMENT_ID, { environment: { capabilities: server.capabilities } }]],
    ),
}));

const { ComputerEnvironmentPolicySection } = await import("./ComputerEnvironmentPolicySection");

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const TOO_OLD = "Pathway server to change these settings.";

function render() {
  return renderToStaticMarkup(
    <ComputerEnvironmentPolicySection environmentId={ENVIRONMENT_ID} writeAccess="granted" />,
  );
}

/** How many of the two policy selects render disabled. */
function disabledSelects(markup: string): number {
  return markup.match(/<button type="button" data-disabled=""/g)?.length ?? 0;
}

afterEach(() => {
  server.capabilities = undefined;
});

describe("ComputerEnvironmentPolicySection", () => {
  it("locks the policy on a server that would drop the patch, and says why", () => {
    server.capabilities = { computerOperateScope: true };
    const markup = render();
    expect(markup).toContain(TOO_OLD);
    expect(disabledSelects(markup)).toBe(2);
  });

  it("lets an admin change the policy where the server takes it", () => {
    server.capabilities = { computerOperateScope: true, computerPolicy: true };
    const markup = render();
    expect(markup).not.toContain(TOO_OLD);
    expect(disabledSelects(markup)).toBe(0);
  });

  it("holds the controls, without blaming the server, until its config arrives", () => {
    const markup = render();
    expect(markup).not.toContain(TOO_OLD);
    expect(disabledSelects(markup)).toBe(2);
  });
});
