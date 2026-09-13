import { createFileRoute, redirect } from "@tanstack/react-router";

import { isElectron } from "../env";

import { SnapShotSettings } from "../components/settings/SnapShotSettings";

function SettingsSnapShotRoute() {
  return <SnapShotSettings />;
}

export const Route = createFileRoute("/settings/snap-shot")({
  beforeLoad: () => {
    if (!isElectron) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsSnapShotRoute,
});
