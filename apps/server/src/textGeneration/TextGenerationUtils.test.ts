import { describe, expect, it } from "@effect/vitest";
import { TextGenerationError } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  cliErrorOutputTail,
  isTextGenerationAuthenticationError,
  readCliStderr,
} from "./TextGenerationUtils.ts";

const encoder = new TextEncoder();

describe("CLI diagnostic tails", () => {
  it("preserves small diagnostics and retains the end of oversized Unicode output", () => {
    expect(cliErrorOutputTail("small failure")).toBe("small failure");
    const tail = cliErrorOutputTail("discard me" + "😀".repeat(8_000) + "final failure");
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(16 * 1024);
    expect(tail).toMatch(/^\[truncated earlier output\]\n/);
    expect(tail).toMatch(/final failure$/);
    expect(tail).not.toContain("discard me");
    expect(tail).not.toContain("�");
  });

  it.effect("drains every stderr chunk and keeps a single marker plus the latest failure", () =>
    Effect.gen(function* () {
      let drained = 0;
      const chunks = [
        "first failure" + "x".repeat(20_000),
        "y".repeat(4_000),
        "refresh_token_reused",
      ];
      const output = yield* readCliStderr(
        "codex",
        "investigate",
        Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              drained += 1;
            }),
          ),
        ),
      );
      expect(drained).toBe(chunks.length);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024);
      expect(output.split("[truncated earlier output]")).toHaveLength(2);
      expect(output).toMatch(/refresh_token_reused$/);
      expect(output).not.toContain("first failure");
    }),
  );

  it.effect("keeps UTF-8 characters split across input chunks intact", () =>
    Effect.gen(function* () {
      const bytes = encoder.encode("failure 😀");
      const output = yield* readCliStderr(
        "claude",
        "investigate",
        Stream.make(bytes.slice(0, -2), bytes.slice(-2)),
      );
      expect(output).toBe("failure 😀");
    }),
  );
});

describe("provider authentication failures", () => {
  it("recognizes explicit credential errors, including wrapped HTTP status", () => {
    for (const detail of [
      "refresh_token_reused",
      "Your refresh token was already used",
      "HTTP error 401 Unauthorized",
      "status: 401",
    ]) {
      expect(
        isTextGenerationAuthenticationError(
          new TextGenerationError({ operation: "investigate", detail }),
        ),
      ).toBe(true);
    }
    for (const cause of [
      { cause: { status: 401 } },
      { cause: { response: { status: 401 } } },
      { statusCode: 401 },
      { code: "refresh_token_reused" },
    ]) {
      expect(
        isTextGenerationAuthenticationError(
          new TextGenerationError({ operation: "investigate", detail: "SDK failed", cause }),
        ),
      ).toBe(true);
    }
  });

  it("leaves quota, transport, incidental numbers, and unrelated errors retryable", () => {
    for (const detail of [
      "429 Too Many Requests",
      "503 Service Unavailable",
      "ECONNRESET",
      "Failed to read line 401",
      "refresh token request timed out",
    ]) {
      expect(
        isTextGenerationAuthenticationError(
          new TextGenerationError({ operation: "investigate", detail }),
        ),
      ).toBe(false);
    }
    expect(isTextGenerationAuthenticationError(new Error("401 Unauthorized"))).toBe(false);
    for (const cause of [{ response: { status: 429 } }, { status: 503 }]) {
      expect(
        isTextGenerationAuthenticationError(
          new TextGenerationError({ operation: "investigate", detail: "SDK failed", cause }),
        ),
      ).toBe(false);
    }
  });
});
