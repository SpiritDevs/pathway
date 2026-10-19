import { createFileRoute } from "@tanstack/react-router";

import { ImportSettingsPanel } from "../components/settings/issues/ImportSettingsPanel";

export const Route = createFileRoute("/settings/issues-import")({
  component: ImportSettingsPanel,
});
