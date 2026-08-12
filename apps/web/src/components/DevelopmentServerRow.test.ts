import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEVELOPMENT_SERVER_ROW_ACTIONS,
  getDevelopmentServerRowState,
} from "./DevelopmentServerRow.logic";

function server(pid: number | null): DiscoveredLocalServer {
  return {
    host: "localhost",
    port: 5_173,
    url: "http://localhost:5173",
    processName: "vite",
    pid,
    terminal: null,
  };
}

describe("development server row", () => {
  it("offers open, copy, and stop as the basic actions", () => {
    expect(DEVELOPMENT_SERVER_ROW_ACTIONS).toEqual({
      open: "Open",
      copy: "Copy URL",
      stop: "Stop",
    });
    expect(getDevelopmentServerRowState(server(12_345))).toEqual({
      label: "vite",
      address: "localhost:5173",
      canStop: true,
    });
  });

  it("disables stopping when discovery cannot identify the owning process", () => {
    expect(getDevelopmentServerRowState(server(null)).canStop).toBe(false);
  });
});
