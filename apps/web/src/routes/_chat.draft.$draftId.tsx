import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/draft/$draftId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/threads/draft/$draftId",
      params: { draftId: params.draftId },
      replace: true,
    });
  },
});
