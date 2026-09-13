import { createFileRoute } from "@tanstack/react-router";
import { DictationPage } from "../components/dictation/DictationPage";

export const Route = createFileRoute("/settings/dictation_/settings")({
  component: () => <DictationPage page="settings" />,
});
