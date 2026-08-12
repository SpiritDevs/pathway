import type { DevelopmentServerPortRange, DiscoveredLocalServer } from "@t3tools/contracts";

export function filterDiscoveredPorts(
  ports: ReadonlyArray<DiscoveredLocalServer>,
  range: DevelopmentServerPortRange,
): ReadonlyArray<DiscoveredLocalServer> {
  return ports.filter((port) => port.port >= range.from && port.port <= range.to);
}
