import { createFileRoute } from "@tanstack/react-router";

import { AppleAccountsSettings } from "../components/settings/AppleAccountsSettings";

export const Route = createFileRoute("/settings/apple")({
  component: AppleAccountsSettings,
});
