import { createFileRoute, redirect } from "@tanstack/react-router";

export function integrationsAnchorForLegacyIntakeHash(hash: string): string {
  const anchor = hash.replace(/^#/, "");
  return anchor === "slack-bot-token" || anchor === "slack-watched-channels"
    ? "issue-intake"
    : anchor;
}

export const Route = createFileRoute("/settings/issues-intake")({
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/settings/integrations",
      hash: integrationsAnchorForLegacyIntakeHash(location.hash),
      replace: true,
    });
  },
});
