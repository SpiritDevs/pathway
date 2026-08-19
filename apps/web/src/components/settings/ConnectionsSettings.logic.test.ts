import type { AdvertisedEndpoint, DesktopWslState, EnvironmentId } from "@spiritdevs/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  excludeRepresentedEnvironmentClientSessions,
  isQrShareableEndpoint,
  partitionClientSessionsByConnection,
  partitionEnvironmentsByConnection,
  selectQrEndpointOption,
} from "./ConnectionsSettings.logic";

describe("partitionEnvironmentsByConnection", () => {
  const environment = (label: string, phase: string) => ({ label, connection: { phase } });

  it("only classifies live environments as connected", () => {
    const result = partitionEnvironmentsByConnection([
      environment("Connected", "connected"),
      environment("Connecting", "connecting"),
      environment("Reconnecting", "reconnecting"),
      environment("Idle", "idle"),
      environment("Failed", "error"),
    ]);

    expect(result.connected.map(({ label }) => label)).toEqual(["Connected"]);
    expect(result.disconnected.map(({ label }) => label)).toEqual([
      "Connecting",
      "Reconnecting",
      "Idle",
      "Failed",
    ]);
  });

  it("returns empty groups when the catalog is empty", () => {
    expect(partitionEnvironmentsByConnection([])).toEqual({ connected: [], disconnected: [] });
  });
});

describe("partitionClientSessionsByConnection", () => {
  it("keeps the current and live sessions above the disconnected fold", () => {
    const current = { id: "current", current: true, connected: false };
    const live = { id: "live", current: false, connected: true };
    const offline = { id: "offline", current: false, connected: false };

    expect(partitionClientSessionsByConnection([current, live, offline])).toEqual({
      connected: [current, live],
      disconnected: [offline],
    });
  });
});

describe("excludeRepresentedEnvironmentClientSessions", () => {
  it("keeps client-only access and hides sessions represented by environments", () => {
    type Session = {
      readonly id: string;
      readonly subject: string;
      readonly current: boolean;
      readonly client: { readonly deviceType: string; readonly browser?: string };
      readonly initiatingEnvironmentId?: EnvironmentId;
    };
    const webPortal: Session = {
      id: "web",
      subject: "one-time-token",
      current: true,
      client: { deviceType: "desktop", browser: "Chrome" },
    };
    const mobile: Session = {
      id: "mobile",
      subject: "one-time-token",
      current: false,
      client: { deviceType: "mobile" },
    };
    const representedDesktop: Session = {
      id: "desktop",
      subject: "cloud-connect",
      current: false,
      client: { deviceType: "desktop", browser: "Electron" },
      initiatingEnvironmentId: "environment-studio" as EnvironmentId,
    };
    const unrepresentedDesktop: Session = {
      id: "old-desktop",
      subject: "cloud-connect",
      current: false,
      client: { deviceType: "desktop", browser: "Electron" },
      initiatingEnvironmentId: "environment-removed" as EnvironmentId,
    };

    expect(
      excludeRepresentedEnvironmentClientSessions(
        [webPortal, mobile, representedDesktop, unrepresentedDesktop],
        [{ environmentId: "environment-studio" as EnvironmentId }],
      ),
    ).toEqual([webPortal, mobile, unrepresentedDesktop]);
  });

  it("hides the desktop's current bootstrap session when its environment is registered", () => {
    const currentDesktop = {
      id: "desktop-current",
      subject: "desktop-bootstrap",
      current: true,
      client: { deviceType: "desktop" },
    };
    const webPortal = {
      id: "web",
      subject: "one-time-token",
      current: false,
      client: { deviceType: "desktop", browser: "Chrome" },
    };

    expect(
      excludeRepresentedEnvironmentClientSessions([currentDesktop, webPortal], [], true),
    ).toEqual([webPortal]);
  });

  it("keeps the current session visible on clients that do not host an environment", () => {
    const currentWebPortal = {
      id: "web-current",
      subject: "cloud-connect",
      current: true,
      client: { deviceType: "desktop", browser: "Chrome" },
    };

    expect(excludeRepresentedEnvironmentClientSessions([currentWebPortal], [], false)).toEqual([
      currentWebPortal,
    ]);
  });

  it("hides legacy Electron relay sessions that predate environment attribution", () => {
    const legacyDesktop = {
      id: "legacy-desktop",
      subject: "cloud-connect",
      current: false,
      client: { deviceType: "desktop", browser: "Electron" },
    };
    const webPortal = {
      id: "web",
      subject: "cloud-connect",
      current: false,
      client: { deviceType: "desktop", browser: "Chrome" },
    };

    expect(
      excludeRepresentedEnvironmentClientSessions([legacyDesktop, webPortal], [], true),
    ).toEqual([webPortal]);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });

  it("stages WSL-only before enabling without rewriting an unchanged distro", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = false;
    const setWslDistro = vi.fn(async () => baseWslState);
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, wslOnly: enabled };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return { ...baseWslState, enabled, wslOnly: persistedWslOnly };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "wsl-only",
      nextDistro: null,
      persistedDistro: null,
    });

    expect(calls).toEqual(["setWslOnly:true", "setWslBackendEnabled:true"]);
    expect(setWslDistro).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, wslOnly: true });
  });
});

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:4780",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:4780",
    wsBaseUrl: "ws://192.168.1.42:4780",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

describe("isQrShareableEndpoint", () => {
  it("excludes loopback endpoints so a scanned phone never dials itself", () => {
    expect(
      isQrShareableEndpoint(
        makeEndpoint({
          id: "desktop-loopback:4780",
          reachability: "loopback",
          httpBaseUrl: "http://127.0.0.1:4780",
        }),
      ),
    ).toBe(false);
  });

  it("excludes unavailable endpoints and keeps reachable ones", () => {
    expect(isQrShareableEndpoint(makeEndpoint({ status: "unavailable" }))).toBe(false);
    expect(isQrShareableEndpoint(makeEndpoint({}))).toBe(true);
    expect(
      isQrShareableEndpoint(makeEndpoint({ reachability: "private-network", status: "unknown" })),
    ).toBe(true);
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "private-ip:http://100.84.12.7:4780",
      preferenceKey: "private:ip:http",
      qrShareable: true,
    },
    {
      id: "private-ip:http://100.84.12.8:4780",
      preferenceKey: "private:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "private-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "private-ip:http://100.84.12.8:4780",
    );
  });

  it("falls back to the saved default preference key when nothing is selected", () => {
    expect(selectQrEndpointOption(options, null, "desktop-core:lan:http")?.id).toBe(
      "desktop-lan:http://192.168.1.42:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "private-ip:gone", "nope")?.id).toBe(
      "private-ip:http://100.84.12.7:4780",
    );
  });

  it("returns the first option when nothing is QR-shareable, and null when empty", () => {
    const loopbackOnly = options.slice(0, 1);
    expect(selectQrEndpointOption(loopbackOnly, null, null)?.id).toBe("desktop-loopback:4780");
    expect(selectQrEndpointOption([], "anything", "anything")).toBeNull();
  });
});
