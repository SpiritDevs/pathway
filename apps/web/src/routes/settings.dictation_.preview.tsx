import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Preview = import.meta.env.DEV
  ? lazy(() =>
      import("../components/dictation/DictationPreview").then((module) => ({
        default: module.DictationPreview,
      })),
    )
  : () => null;

export const Route = createFileRoute("/settings/dictation_/preview")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw redirect({ to: "/settings/general", replace: true });
  },
  component: () => (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  ),
});
