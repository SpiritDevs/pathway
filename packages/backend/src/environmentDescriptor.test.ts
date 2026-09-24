import { ExecutionEnvironmentCapabilities } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sameDescriptor } from "../convex/environments.ts";

const descriptor = {
  environmentId: "environment",
  label: "Mac",
  serverVersion: "0.0.41",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: { repositoryIdentity: true },
};

describe("environment descriptor", () => {
  it("publishes a registration that changes only Computer policy support", () => {
    const next = {
      ...descriptor,
      capabilities: { ...descriptor.capabilities, computerPolicy: true },
    };
    expect(sameDescriptor(descriptor, next)).toBe(false);
  });

  // Registration skips publishing when the descriptors match, so a capability
  // left out of the comparison never reaches clients that gate on it.
  it.each(Object.keys(ExecutionEnvironmentCapabilities.fields))(
    "publishes a registration that changes only %s",
    (capability) => {
      const next = {
        ...descriptor,
        capabilities: { ...descriptor.capabilities, [capability]: "changed" },
      };
      expect(sameDescriptor(descriptor, next)).toBe(false);
    },
  );

  it("publishes nothing for an identical registration", () => {
    expect(sameDescriptor(descriptor, structuredClone(descriptor))).toBe(true);
  });
});
