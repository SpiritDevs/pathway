import { createFileRoute } from "@tanstack/react-router";
import { AssetsSettingsPanel } from "../components/settings/AssetsSettingsPanel";
export const Route = createFileRoute("/settings/assets")({ component: AssetsSettingsPanel });
