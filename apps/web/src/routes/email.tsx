import { createFileRoute } from "@tanstack/react-router";
import { MailIcon } from "lucide-react";

import { PlaceholderWorkspacePage } from "../components/workspace/PlaceholderWorkspacePage";

function EmailPage() {
  return (
    <PlaceholderWorkspacePage
      description="Your connected inbox will appear here."
      icon={MailIcon}
      title="Email"
    />
  );
}

export const Route = createFileRoute("/email")({
  component: EmailPage,
});
