import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestratorConfig, defaultOrchestratorConfig } from "./aiOrchestrator.ts";
import {
  DEFAULT_PERSONALITY,
  OrchestratorPersonality,
  normalizeAvatarExpression,
  personalityPrompt,
  resolvePersonality,
} from "./orchestratorAvatar.ts";
const decode = Schema.decodeUnknownSync(OrchestratorPersonality);
const decodeConfig = Schema.decodeUnknownSync(OrchestratorConfig);

describe("orchestrator personality compatibility", () => {
  it("reads legacy records without opting them into new tone instructions", () => {
    const { avatar: _avatar, personality: _personality, ...legacy } = defaultOrchestratorConfig();
    const config = decodeConfig(legacy);
    expect(config.personality).toBeUndefined();
    expect(config.persona).toBe(legacy.persona);
    expect(personalityPrompt(config.personality)).toBe("");
  });
  it("inherits untouched traits and resets advanced overrides independently", () => {
    const personality = decode({
      shared: DEFAULT_PERSONALITY,
      replies: { energy: 80 },
      avatar: { warmth: 95 },
    });
    expect(resolvePersonality(personality, "replies")).toEqual({
      ...DEFAULT_PERSONALITY,
      energy: 80,
    });
    expect(resolvePersonality(personality, "avatar")).toEqual({
      ...DEFAULT_PERSONALITY,
      warmth: 95,
    });
    const changed = { ...personality, shared: { ...personality.shared, curiosity: 90 } };
    expect(resolvePersonality(changed, "replies").curiosity).toBe(90);
    const { replies: _replies, ...resetReplies } = changed;
    expect(resolvePersonality(resetReplies, "replies")).toEqual(changed.shared);
    expect(personalityPrompt(personality)).toContain("Energy 80");
    expect(personalityPrompt(personality)).toContain(`Warmth ${DEFAULT_PERSONALITY.warmth}`);
  });
  it.each([-1, 101, 2.5, NaN, Infinity])("rejects invalid slider value %s", (energy) => {
    expect(() => decode({ shared: { ...DEFAULT_PERSONALITY, energy } })).toThrow();
    expect(() => decode({ shared: DEFAULT_PERSONALITY, avatar: { energy } })).toThrow();
  });
  it.each([undefined, null, "unsupported", { expression: "pleased" }])(
    "falls back safely for unknown expression %s",
    (expression) => {
      expect(normalizeAvatarExpression(expression)).toBe("neutral");
    },
  );
  it("retains a known expression", () =>
    expect(normalizeAvatarExpression("curious")).toBe("curious"));
});
