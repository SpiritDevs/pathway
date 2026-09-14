import { useId, useState } from "react";
import type { OrchestratorConfig } from "@spiritdevs/contracts/aiOrchestrator";
import {
  AVATAR_SHAPES,
  AVATAR_EYES,
  AVATAR_EXPRESSIONS,
  DEFAULT_AVATAR,
  DEFAULT_PERSONALITY,
  PERSONALITY_PRESETS,
  PERSONALITY_TRAITS,
  resolvePersonality,
  type AvatarExpression,
  type PersonalityTraits,
} from "@spiritdevs/contracts/orchestratorAvatar";
import { Button } from "../ui/button";
import { OrchestratorAvatar, ORCHESTRATOR_COLORS } from "./OrchestratorAvatar";
import { cn } from "../../lib/utils";

export function AvatarSettings({
  config,
  onChange,
}: {
  config: OrchestratorConfig;
  onChange: (patch: Partial<OrchestratorConfig>) => void;
}) {
  const id = useId();
  const [expression, setExpression] = useState<AvatarExpression>("neutral");
  const [advanced, setAdvanced] = useState(false);
  const appearance = config.avatar ?? DEFAULT_AVATAR;
  const personality = config.personality ?? { shared: DEFAULT_PERSONALITY };
  const changeTrait = (
    target: "shared" | "avatar" | "replies",
    trait: keyof PersonalityTraits,
    value: number,
  ) => {
    onChange({
      personality: { ...personality, [target]: { ...personality[target], [trait]: value } },
    });
  };
  const sliders = (target: "shared" | "avatar" | "replies") => {
    const values =
      target === "shared" ? personality.shared : resolvePersonality(personality, target);
    return (
      <div className="grid gap-4">
        {PERSONALITY_TRAITS.map((trait) => (
          <div key={trait.id}>
            <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
              <label htmlFor={`${id}-${target}-${trait.id}`} className="font-medium">
                {trait.label}
              </label>
              <output
                htmlFor={`${id}-${target}-${trait.id}`}
                className="tabular-nums text-muted-foreground"
              >
                {values[trait.id]}
              </output>
            </div>
            <input
              id={`${id}-${target}-${trait.id}`}
              type="range"
              min={0}
              max={100}
              step={1}
              value={values[trait.id]}
              aria-valuetext={`${values[trait.id]} of 100, ${trait.low} to ${trait.high}`}
              onChange={(event) => changeTrait(target, trait.id, Number(event.target.value))}
              className="block h-5 w-full cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-ring"
            />
            <div className="mt-1 flex justify-between gap-2 text-[11px] text-muted-foreground">
              <span>{trait.low}</span>
              <span>{trait.high}</span>
            </div>
          </div>
        ))}
      </div>
    );
  };
  return (
    <section aria-label="Appearance and personality" className="grid gap-6 border-y py-6">
      <div className="flex flex-wrap items-center gap-5">
        <div className="flex size-28 shrink-0 items-center justify-center rounded-2xl bg-muted/50">
          <OrchestratorAvatar
            contact={config}
            expression={expression}
            className="size-20"
            interactive
            idle
          />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <h3 className="text-sm font-semibold">
            A face for {config.name.trim() || "your orchestrator"}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Their appearance and personality follow them into every conversation.
          </p>
          <label className="flex items-center gap-2 text-xs">
            Preview
            <select
              value={expression}
              onChange={(event) => setExpression(event.target.value as AvatarExpression)}
              className="min-w-0 rounded-md border bg-background px-2 py-1 capitalize"
            >
              {AVATAR_EXPRESSIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-xs font-medium">Shape</legend>
        <div className="flex flex-wrap gap-2">
          {AVATAR_SHAPES.map((shape) => (
            <button
              key={shape}
              type="button"
              aria-label={`${shape} shape`}
              aria-pressed={appearance.shape === shape}
              onClick={() => onChange({ avatar: { ...appearance, shape } })}
              className={cn(
                "flex flex-col items-center gap-1 rounded-xl border p-2 text-[11px] capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring",
                appearance.shape === shape && "border-primary bg-primary/5",
              )}
            >
              <OrchestratorAvatar
                contact={{ ...config, avatar: { ...appearance, shape } }}
                className="size-9"
              />
              {shape}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-6">
        <fieldset>
          <legend className="mb-2 text-xs font-medium">Colour</legend>
          <div className="flex flex-wrap gap-2">
            {Object.entries(ORCHESTRATOR_COLORS).map(([color, style]) => (
              <button
                type="button"
                key={color}
                aria-label={`${color} avatar`}
                aria-pressed={config.color === color}
                onClick={() => onChange({ color })}
                className={cn(
                  "size-7 rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  style,
                  config.color === color && "ring-2 ring-ring",
                )}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-medium">Eyes</legend>
          <div className="flex flex-wrap gap-1">
            {AVATAR_EYES.map((eyes) => (
              <Button
                key={eyes}
                type="button"
                variant={appearance.eyes === eyes ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={appearance.eyes === eyes}
                onClick={() => onChange({ avatar: { ...appearance, eyes } })}
                className="capitalize"
              >
                {eyes}
              </Button>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Personality</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Start with a personality, then make it their own. These sliders shape both their replies
          and their expressions.
        </p>
        {!config.personality && (
          <p className="text-xs text-muted-foreground">
            Their written persona stays in effect. Adjust a slider or choose a preset to apply these
            settings.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {PERSONALITY_PRESETS.map((preset) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              key={preset.name}
              aria-pressed={
                !!config.personality &&
                PERSONALITY_TRAITS.every(
                  ({ id: trait }) => personality.shared[trait] === preset.traits[trait],
                )
              }
              onClick={() => onChange({ personality: { ...personality, shared: preset.traits } })}
            >
              {preset.name}
            </Button>
          ))}
        </div>
      </div>
      {sliders("shared")}
      <div className="space-y-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={advanced}
          aria-controls={`${id}-advanced`}
          onClick={() => setAdvanced((value) => !value)}
        >
          Advanced
          {config.personality?.avatar || config.personality?.replies ? " · Custom overrides" : ""}
        </Button>
        {advanced && (
          <div id={`${id}-advanced`} className="space-y-5 border-t pt-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Tune replies and avatar reactions separately. Untouched sliders follow the shared
              personality. Even an energetic avatar rests between reactions.
            </p>
            <div className="grid gap-6 sm:grid-cols-2">
              {(["replies", "avatar"] as const).map((target) => (
                <fieldset key={target} className="min-w-0">
                  <legend className="mb-4 text-xs font-semibold">
                    {target === "replies" ? "Replies" : "Avatar reactions"}
                  </legend>
                  {sliders(target)}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      const next = { ...personality };
                      delete next[target];
                      onChange({ personality: next });
                    }}
                  >
                    Reset {target === "replies" ? "replies" : "avatar"} to shared
                  </Button>
                </fieldset>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
