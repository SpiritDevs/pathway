import { FOCUS_ICON_OPTIONS } from "./FocusIcon";

/** One palette for every library icon, so Focus and project colors read as a set. */
export const LIBRARY_ICON_COLORS = [
  "#3b82f6",
  "#06b6d4",
  "#14b8a6",
  "#22c55e",
  "#84cc16",
  "#f59e0b",
  "#f97316",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
] as const;

/** The built-in icon grid plus color swatches, shared by Focus and project editors. */
export function IconColorPicker(props: {
  readonly subject: string;
  readonly iconName: string;
  readonly color: string;
  readonly disabled?: boolean;
  readonly onIconChange: (iconName: string) => void;
  readonly onColorChange: (color: string) => void;
}) {
  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-2">
        <legend className="text-xs font-medium text-foreground">Icon</legend>
        <div
          className="grid grid-cols-10 gap-1"
          role="radiogroup"
          aria-label={`${props.subject} icon`}
        >
          {FOCUS_ICON_OPTIONS.map((option) => (
            <button
              key={option.name}
              type="button"
              role="radio"
              aria-checked={props.iconName === option.name}
              aria-label={option.label}
              title={option.label}
              disabled={props.disabled}
              onClick={() => props.onIconChange(option.name)}
              className="flex aspect-square cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-foreground/[0.09] aria-checked:text-foreground disabled:pointer-events-none disabled:opacity-60"
            >
              <option.icon className="size-3.5" />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-xs font-medium text-foreground">Color</legend>
        <div
          className="flex items-center justify-between"
          role="radiogroup"
          aria-label={`${props.subject} color`}
        >
          {LIBRARY_ICON_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={props.color.toLowerCase() === color}
              aria-label={color}
              disabled={props.disabled}
              onClick={() => props.onColorChange(color)}
              className="relative flex size-6 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60"
            >
              <span
                className="size-4 rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-popover transition-transform aria-hidden:scale-110"
                style={{ backgroundColor: color }}
              />
              {props.color.toLowerCase() === color ? (
                <span
                  className="pointer-events-none absolute size-5 rounded-full ring-2 ring-current"
                  style={{ color }}
                />
              ) : null}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
