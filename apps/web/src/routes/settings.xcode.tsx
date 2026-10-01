import { createFileRoute } from "@tanstack/react-router";

import { XcodeSettings } from "../components/settings/XcodeSettings";

export const Route = createFileRoute("/settings/xcode")({
  component: XcodeSettings,
});
