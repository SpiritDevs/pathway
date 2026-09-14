import * as Schema from "effect/Schema";

export const AVATAR_SHAPES = ["round", "pebble", "squircle", "cloud", "drop", "flower"] as const;
export const AVATAR_EYES = ["oval", "round", "soft", "wide"] as const;
export const AVATAR_EXPRESSIONS = [
  "neutral",
  "curious",
  "thoughtful",
  "pleased",
  "concerned",
  "encouraging",
] as const;
export const AvatarExpression = Schema.Literals(AVATAR_EXPRESSIONS);
export type AvatarExpression = typeof AvatarExpression.Type;
export const OrchestratorAvatarConfig = Schema.Struct({
  shape: Schema.Literals(AVATAR_SHAPES),
  eyes: Schema.Literals(AVATAR_EYES),
});
export type OrchestratorAvatarConfig = typeof OrchestratorAvatarConfig.Type;
const level = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
export const PersonalityTraits = Schema.Struct({
  warmth: level,
  playfulness: level,
  energy: level,
  curiosity: level,
  expressiveness: level,
});
export type PersonalityTraits = typeof PersonalityTraits.Type;
const TraitOverrides = Schema.Struct({
  warmth: Schema.optionalKey(level),
  playfulness: Schema.optionalKey(level),
  energy: Schema.optionalKey(level),
  curiosity: Schema.optionalKey(level),
  expressiveness: Schema.optionalKey(level),
});
export const OrchestratorPersonality = Schema.Struct({
  shared: PersonalityTraits,
  replies: Schema.optionalKey(TraitOverrides),
  avatar: Schema.optionalKey(TraitOverrides),
});
export type OrchestratorPersonality = typeof OrchestratorPersonality.Type;
export const PERSONALITY_TRAITS = [
  { id: "warmth", label: "Warmth", low: "Reserved", high: "Affectionate" },
  { id: "playfulness", label: "Playfulness", low: "Serious", high: "Whimsical" },
  { id: "energy", label: "Energy", low: "Calm", high: "Enthusiastic" },
  { id: "curiosity", label: "Curiosity", low: "Focused", high: "Exploratory" },
  { id: "expressiveness", label: "Expressiveness", low: "Understated", high: "Animated" },
] as const;
export const PERSONALITY_PRESETS = [
  {
    name: "Calm colleague",
    traits: { warmth: 65, playfulness: 20, energy: 25, curiosity: 45, expressiveness: 35 },
  },
  {
    name: "Curious thinker",
    traits: { warmth: 55, playfulness: 35, energy: 45, curiosity: 85, expressiveness: 50 },
  },
  {
    name: "Playful helper",
    traits: { warmth: 80, playfulness: 80, energy: 70, curiosity: 65, expressiveness: 80 },
  },
] as const satisfies readonly { name: string; traits: PersonalityTraits }[];
export const DEFAULT_AVATAR: OrchestratorAvatarConfig = { shape: "round", eyes: "oval" };
export const DEFAULT_PERSONALITY: PersonalityTraits = PERSONALITY_PRESETS[0].traits;
export function resolvePersonality(
  personality: OrchestratorPersonality | undefined,
  target: "replies" | "avatar",
): PersonalityTraits {
  return { ...(personality?.shared ?? DEFAULT_PERSONALITY), ...personality?.[target] };
}

const isAvatarExpression = Schema.is(AvatarExpression);

/** Unknown expression metadata must never discard an otherwise valid response. */
export function normalizeAvatarExpression(value: unknown): AvatarExpression {
  return isAvatarExpression(value) ? value : "neutral";
}

export function personalityPrompt(personality: OrchestratorPersonality | undefined): string {
  if (!personality) return "";
  const traits = resolvePersonality(personality, "replies");
  return `Conversational personality (0–100): ${PERSONALITY_TRAITS.map((trait) => `${trait.label} ${traits[trait.id]} (${trait.low} to ${trait.high})`).join("; ")}. Use these settings for conversational style while retaining the role and substantive guidance in your written persona, responsibilities, accuracy, and permissions. They do not grant new autonomy. Choose a matching expression for the tone of your message.`;
}
