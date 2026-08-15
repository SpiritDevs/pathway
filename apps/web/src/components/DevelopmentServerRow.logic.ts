import type { DiscoveredLocalServer } from "@spiritdevs/contracts";

export const DEVELOPMENT_SERVER_ROW_ACTIONS = {
  open: "Open",
  copy: "Copy URL",
  stop: "Stop",
} as const;

export function getDevelopmentServerRowState(server: DiscoveredLocalServer) {
  return {
    label: server.processName ?? "Local server",
    address: `localhost:${server.port}`,
    canStop: server.pid !== null,
  };
}
