/**
 * The burn-up's ink, mirroring `usage/usageProviders.ts`.
 *
 * The burn-up is an **emphasis** chart, not a categorical one: completed work is the point and
 * scope is the context it moves against, so there is one hue and one neutral rather than two hues.
 * Every mark paints with `currentColor` under the Tailwind text token named here, so a custom
 * theme that restyles `--primary` restyles the chart with it — the hexes below are what those
 * tokens resolve to on the stock light and dark themes, recorded because a palette that was never
 * measured is a palette nobody can change safely.
 *
 * Measured with the data-viz validator against each mode's `--background`:
 *
 * | role      | light     | contrast | dark      | contrast |
 * |-----------|-----------|----------|-----------|----------|
 * | completed | `#1b4ed8` | 6.54:1   | `#346bf1` | 4.26:1   |
 * | scope     | `#71717b` | 4.71:1   | `#818181` | 5.08:1   |
 * | ideal     | `#8d8d95` | 3.21:1   | `#696969` | 3.61:1   |
 *
 * All three clear the 3:1 floor for marks in both modes, and the emphasis hue clears the
 * categorical checks on its own. The two-slot categorical run reports one FAIL — the chroma floor,
 * on `scope` — which is the neutral doing its job: a de-emphasis gray is the emphasis form's
 * second colour by definition, and the validator says in its own output that those six checks
 * score categorical palettes only.
 *
 * @module components/issues/milestoneChartColors
 */

export interface MilestoneChartInk {
  /** Tailwind text token. Marks stroke and fill `currentColor` so themes carry through. */
  readonly className: string;
  /** What the token resolves to on the stock light theme — the value the validator scored. */
  readonly light: string;
  /** The dark step, chosen and measured for the dark surface rather than flipped from light. */
  readonly dark: string;
}

/** `--background` per mode: what the marks above were measured against. */
export const MILESTONE_CHART_SURFACE = { light: "#fcfcfc", dark: "#0a0a0a" } as const;

export const MILESTONE_CHART_INK = {
  /** Completed issues — the emphasis hue, as a filled area under a solid line. */
  completed: { className: "text-primary", light: "#1b4ed8", dark: "#346bf1" },
  /** Total scope — de-emphasis ink, a line only. It is the ceiling, not the story. */
  scope: { className: "text-muted-foreground", light: "#71717b", dark: "#818181" },
  /**
   * The ideal-pace reference. Same ink as scope, dashed and dimmed to
   * {@link MILESTONE_CHART_IDEAL_OPACITY} so it reads as an annotation rather than a third series
   * — the light and dark hexes above are that dimmed ink composited on the surface.
   */
  ideal: { className: "text-muted-foreground", light: "#8d8d95", dark: "#696969" },
} as const satisfies Record<string, MilestoneChartInk>;

/** Faint enough that the scope line stays legible where it crosses the completed area. */
export const MILESTONE_CHART_AREA_OPACITY = 0.14;

/** Dims the reference line below both series while keeping it above the 3:1 mark floor. */
export const MILESTONE_CHART_IDEAL_OPACITY = 0.8;

/** Dash pattern for the reference line — the texture, not the colour, is what marks it as one. */
export const MILESTONE_CHART_IDEAL_DASH = "6 5";

/** Series stroke width, in screen pixels (`vector-effect="non-scaling-stroke"`). */
export const MILESTONE_CHART_STROKE_WIDTH = 2;
