import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
const Fixture = import.meta.env.DEV
  ? lazy(() =>
      import("../components/assets/AssetReviewFixture").then((module) => ({
        default: module.AssetReviewFixture,
      })),
    )
  : null;
export const Route = createFileRoute("/dev/asset-review")({
  component: () =>
    Fixture ? (
      <Suspense fallback="Loading sample review…">
        <Fixture />
      </Suspense>
    ) : (
      <p>Not found</p>
    ),
});
