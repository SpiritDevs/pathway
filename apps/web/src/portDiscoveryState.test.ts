import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterDiscoveredPorts } from "./portDiscoveryState.logic";

function server(port: number): DiscoveredLocalServer {
  return {
    host: "localhost",
    port,
    url: `http://localhost:${port}`,
    processName: "dev-server",
    pid: port,
    terminal: null,
  };
}

describe("filterDiscoveredPorts", () => {
  it("keeps only servers inside the inclusive configured range", () => {
    expect(
      filterDiscoveredPorts([server(2_999), server(3_000), server(9_999), server(10_000)], {
        from: 3_000,
        to: 9_999,
      }).map((entry) => entry.port),
    ).toEqual([3_000, 9_999]);
  });
});
