import { cn } from "~/lib/utils";

interface ProgressProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** The ratio filled, `0` to `1`. Anything outside that range — or `NaN` — reads as an end of it. */
  value: number;
  /** Styles the filled bar rather than the track, for a tone other than the primary hue. */
  indicatorClassName?: string;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * One ratio against its whole, on a track: milestone completion, a quota, an upload. Give it an
 * `aria-label` when nothing beside it already names what is being measured.
 *
 * `className` styles the track (`h-1.5` unless you say otherwise), `indicatorClassName` the fill.
 * Width is set outright rather than transitioned — a meter that eases toward its value is a meter
 * that repaints every frame a stream is open.
 */
function Progress({ value, className, indicatorClassName, ...props }: ProgressProps) {
  const ratio = clampRatio(value);
  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(ratio * 100)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      data-slot="progress"
      role="progressbar"
      {...props}
    >
      <div
        className={cn("h-full rounded-full bg-primary", indicatorClassName)}
        data-slot="progress-indicator"
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

export { Progress, type ProgressProps };
