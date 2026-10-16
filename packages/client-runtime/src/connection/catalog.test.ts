import { EnvironmentId } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  SshConnectionProfile,
  connectionEntryIsLoopback,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";

const base = { environmentId: EnvironmentId.make("environment-1"), label: "Test" };

function primary(wsBaseUrl: string): ConnectionCatalogEntry {
  return {
    target: new PrimaryConnectionTarget({ ...base, httpBaseUrl: "http://unused", wsBaseUrl }),
    profile: Option.none(),
  };
}

function bearer(wsBaseUrl: string): ConnectionCatalogEntry {
  return {
    target: new BearerConnectionTarget({ ...base, connectionId: "c1" }),
    profile: Option.some(
      new BearerConnectionProfile({
        ...base,
        connectionId: "c1",
        httpBaseUrl: "http://unused",
        wsBaseUrl,
      }),
    ),
  };
}

describe("connectionEntryIsLoopback", () => {
  it("treats loopback primary and bearer endpoints as local", () => {
    expect(connectionEntryIsLoopback(primary("ws://127.0.0.1:3773"))).toBe(true);
    expect(connectionEntryIsLoopback(primary("ws://localhost:3773"))).toBe(true);
    expect(connectionEntryIsLoopback(primary("ws://[::1]:3773"))).toBe(true);
    expect(connectionEntryIsLoopback(bearer("ws://127.0.0.1:3774"))).toBe(true);
  });

  it("treats network endpoints, relay, and SSH as following the network", () => {
    expect(connectionEntryIsLoopback(primary("wss://environment.example.test"))).toBe(false);
    expect(connectionEntryIsLoopback(primary("ws://192.168.1.20:3773"))).toBe(false);
    expect(connectionEntryIsLoopback(bearer("wss://environment.example.test"))).toBe(false);
    expect(
      connectionEntryIsLoopback({
        target: new RelayConnectionTarget(base),
        profile: Option.none(),
      }),
    ).toBe(false);
    expect(
      connectionEntryIsLoopback({
        target: new SshConnectionTarget({ ...base, connectionId: "ssh-1" }),
        profile: Option.some(
          new SshConnectionProfile({
            ...base,
            connectionId: "ssh-1",
            target: { alias: "box", hostname: "box.example.test", username: null, port: null },
          }),
        ),
      }),
    ).toBe(false);
  });
});
