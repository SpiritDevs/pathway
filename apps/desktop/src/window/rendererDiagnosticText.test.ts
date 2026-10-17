import { describe, expect, it } from "vite-plus/test";

import { rendererDiagnosticText } from "./rendererDiagnosticText.ts";

describe("rendererDiagnosticText", () => {
  it("keeps asset origins and filenames while removing credentials, queries, fragments and tokens", () => {
    expect(
      rendererDiagnosticText(
        "Blocked http://user:password@127.0.0.1:3800/api/assets/payload.signature/probe.html?token=secret#theme",
      ),
    ).toBe("Blocked http://127.0.0.1:3800/api/assets/[redacted]/probe.html");
    expect(
      rendererDiagnosticText("/api/assets/payload.signature/probe.html?token=secret#theme"),
    ).toBe("/api/assets/[redacted]/probe.html");
  });

  it("redacts every URL in a Chromium policy message while retaining the policy reason", () => {
    expect(
      rendererDiagnosticText(
        "Refused to frame 'http://127.0.0.1:3800/api/assets/first/probe.html#theme' from 'pathway://app/?secret=value' because of local network access.",
      ),
    ).toBe(
      "Refused to frame 'http://127.0.0.1:3800/api/assets/[redacted]/probe.html' from 'pathway://app/' because of local network access.",
    );
    expect(rendererDiagnosticText("ERR_NETWORK_ACCESS_DENIED")).toBe("ERR_NETWORK_ACCESS_DENIED");
  });

  it("bounds message size after redaction", () => {
    const message = `http://127.0.0.1:3800/api/assets/${"token".repeat(1_000)}/probe.html ${"x".repeat(5_000)}`;
    const result = rendererDiagnosticText(message);
    expect(result).toHaveLength(4_096);
    expect(result).toMatch(/^http:\/\/127\.0\.0\.1:3800\/api\/assets\/\[redacted\]\/probe\.html /);
    expect(result).not.toContain("token");
  });
});
