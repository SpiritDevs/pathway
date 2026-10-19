import { createFileRoute } from "@tanstack/react-router";

import { ActionPaletteSettingsPanel } from "../components/settings/ActionPaletteSettingsSection";

export const Route = createFileRoute("/settings/appearance_/action-palette")({
  component: ActionPaletteSettingsPanel,
});
