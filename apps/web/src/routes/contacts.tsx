import { createFileRoute } from "@tanstack/react-router";

import { ContactsView } from "../components/contacts/ContactsView";

export const Route = createFileRoute("/contacts")({
  component: ContactsView,
});
