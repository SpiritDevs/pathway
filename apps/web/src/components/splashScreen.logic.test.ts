import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../../index.html?raw";
import {
  APP_LOADING_MESSAGES,
  BOOT_SHELL_MESSAGE,
  resolveAuthGateLoadingReason,
  type AppLoadingReason,
} from "./splashScreen.logic";

describe("resolveAuthGateLoadingReason", () => {
  it("separates waiting on the SDK from waiting on the profile", () => {
    expect(resolveAuthGateLoadingReason({ gateState: "loading", isLoaded: false })).toBe("account");
    expect(resolveAuthGateLoadingReason({ gateState: "loading", isLoaded: true })).toBe("profile");
  });

  it("names the destination while a redirect is in flight", () => {
    expect(resolveAuthGateLoadingReason({ gateState: "redirect", isLoaded: true })).toBe("sign-in");
    expect(resolveAuthGateLoadingReason({ gateState: "onboarding", isLoaded: true })).toBe(
      "onboarding",
    );
  });

  it("lets the app through once the gate resolves", () => {
    expect(resolveAuthGateLoadingReason({ gateState: "authenticated", isLoaded: true })).toBeNull();
    expect(resolveAuthGateLoadingReason({ gateState: "public", isLoaded: true })).toBeNull();
  });
});

describe("splash copy", () => {
  it("keeps every reason to one short line", () => {
    for (const message of Object.values(APP_LOADING_MESSAGES)) {
      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThanOrEqual(40);
      expect(message).not.toContain("\n");
    }
  });
});

// The boot shell paints before any bundle runs, so it duplicates the splash by
// hand. These assertions fail when the two frames drift, which is the only way
// the handoff between them becomes visible.
describe("boot shell parity", () => {
  it("renders the same layout classes the component renders", () => {
    expect(indexHtml).toContain('id="boot-shell"');
    for (const className of [
      "boot-shell",
      "boot-stack",
      "boot-logo",
      "boot-message",
      "boot-spinner",
    ]) {
      expect(indexHtml).toContain(`class="${className}"`);
    }
  });

  it("paints the boot message this module owns", () => {
    expect(indexHtml).toContain(`>${BOOT_SHELL_MESSAGE}<`);
  });

  it("lifts the logo by half the message block so it starts screen-centered", () => {
    const lift = indexHtml.match(/--boot-lift:\s*(\d+)px/)?.[1];
    const gap = indexHtml.match(/\.boot-stack\s*\{[\s\S]*?gap:\s*(\d+)px/)?.[1];
    const lineHeight = indexHtml.match(/\.boot-message\s*\{[\s\S]*?line-height:\s*(\d+)px/)?.[1];

    expect(lift).toBeDefined();
    expect(Number(lift)).toBe(Math.round((Number(gap) + Number(lineHeight)) / 2));
  });

  it("declares the animations the component resumes with a negative delay", () => {
    expect(indexHtml).toContain("@keyframes boot-lift");
    expect(indexHtml).toContain("@keyframes boot-message-in");
    expect(indexHtml).toContain("@keyframes boot-spinner");
  });
});

// A reason with no message would render an empty screen, so the table is the
// contract rather than the component's fallback behaviour.
const EVERY_REASON: readonly AppLoadingReason[] = [
  "account",
  "environment",
  "onboarding",
  "profile",
  "sign-in",
];

describe("loading reasons", () => {
  it("has a message for every reason", () => {
    for (const reason of EVERY_REASON) {
      expect(APP_LOADING_MESSAGES[reason]).toBeTruthy();
    }
    expect(Object.keys(APP_LOADING_MESSAGES).sort()).toEqual([...EVERY_REASON].sort());
  });
});
