import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_DESKTOP_BACKEND_PORT,
  DesktopBackendPortUnavailableError,
  DesktopDevelopmentBackendPortRequiredError,
} from "./DesktopApp.ts";

describe("DesktopApp errors", () => {
  it("keeps the packaged backend off the legacy T3 Code default port", () => {
    assert.equal(DEFAULT_DESKTOP_BACKEND_PORT, 3_800);
  });

  it("preserves unavailable backend port context", () => {
    const error = new DesktopBackendPortUnavailableError({
      startPort: DEFAULT_DESKTOP_BACKEND_PORT,
      maxPort: 65_535,
      hosts: ["127.0.0.1", "0.0.0.0", "::"],
    });

    assert.equal(error.startPort, DEFAULT_DESKTOP_BACKEND_PORT);
    assert.equal(error.maxPort, 65_535);
    assert.deepEqual(error.hosts, ["127.0.0.1", "0.0.0.0", "::"]);
    assert.equal(
      error.message,
      "No desktop backend port is available on hosts 127.0.0.1, 0.0.0.0, :: between 3800 and 65535.",
    );
  });

  it("reports the required development port", () => {
    const error = new DesktopDevelopmentBackendPortRequiredError();

    assert.equal(error.message, "PATHWAY_PORT is required in desktop development.");
  });
});
