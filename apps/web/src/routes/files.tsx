import { createFileRoute } from "@tanstack/react-router";

import { FilesView } from "../components/workspaceFiles/FilesView";

export const Route = createFileRoute("/files")({
  component: FilesView,
});
