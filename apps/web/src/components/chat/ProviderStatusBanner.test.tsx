import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

function warningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "Provider is temporarily degraded.",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function unauthenticatedClaudeProvider(): ServerProvider {
  return {
    ...warningProvider(),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    status: "error",
    auth: { status: "unauthenticated", supportsLogin: true },
    message: "Claude is not authenticated.",
  };
}

function unauthenticatedCodexProvider(): ServerProvider {
  return {
    ...warningProvider(),
    status: "error",
    auth: { status: "unauthenticated", supportsLogin: true },
    message: "Codex is not authenticated.",
  };
}

describe("ProviderStatusBanner", () => {
  it("stays hidden after its current warning is dismissed", () => {
    const status = warningProvider();

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(status, getProviderStatusBannerKey(status))).toBe(false);
  });

  it("renders an accessible dismiss control for provider warnings", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss Codex provider warning"');
    expect(markup).toContain("absolute top-2 right-2");
  });

  it("renders on a glass surface so the timeline never reads through the banner", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain("alert-glass");
    expect(markup).toContain('data-variant="warning"');
  });

  it("labels error dismiss controls with the correct severity", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{ ...warningProvider(), status: "error" }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Dismiss Codex provider error"');
  });

  it("renders unauthenticated providers as a sign-in banner instead of a red error", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        authentication={{
          start: async () => ({ flowId: "flow-1", authorizationUrl: "https://claude.com" }),
          complete: async () => {},
          cancel: async () => {},
        }}
        status={unauthenticatedClaudeProvider()}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('data-variant="authentication"');
    expect(markup).toContain("Sign in to Claude");
    expect(markup).toContain(">Sign in</button>");
    expect(markup).not.toContain("border-destructive/32");
  });

  it("offers the shared sign-in action for an unauthenticated Codex instance", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        authentication={{
          start: async () => ({
            flowId: "flow-1",
            authorizationUrl: "https://auth.openai.com/codex/device",
            completion: "browser",
            userCode: "ABCD-EFGH",
          }),
          complete: async () => {},
          cancel: async () => {},
        }}
        status={unauthenticatedCodexProvider()}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("Sign in to Codex");
    expect(markup).toContain(">Sign in</button>");
    expect(markup).not.toContain("Run `codex login`");
  });
});
