import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/threads/$environmentId/$threadId",
      params,
      replace: true,
    });
  },
});
