import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const SNAP_SHOT_EXPORT_MAX_BYTES = 32_000_000;
export const SNAP_SHOT_EXPORT_MAX_DIMENSION = 16_384;
export const SNAP_SHOT_EXPORT_MAX_PIXELS = 40_000_000;
export const SNAP_SHOT_EXPORT_MAX_DATA_URL_CHARS =
  "data:image/png;base64,".length + Math.ceil(SNAP_SHOT_EXPORT_MAX_BYTES / 3) * 4;

export const SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS = 32_000;
export const SNAP_SHOT_ACCESSIBILITY_MAX_NODES = 10_000;
export const SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS = 32_000;

const SnapShotAccessibilityBounds = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
  width: PositiveInt,
  height: PositiveInt,
});

const SnapShotAccessibilityState = Schema.Struct({
  active: Schema.optional(Schema.Boolean),
  busy: Schema.optional(Schema.Boolean),
  checked: Schema.optional(Schema.Literals(["on", "off", "mixed"])),
  editable: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  expanded: Schema.optional(Schema.Boolean),
  focused: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  visible: Schema.optional(Schema.Boolean),
});

export interface SnapShotAccessibilityNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly bounds: typeof SnapShotAccessibilityBounds.Type | null;
  readonly state?: typeof SnapShotAccessibilityState.Type;
  readonly actions?: Array<string>;
  readonly children: Array<SnapShotAccessibilityNode>;
}

export const SnapShotAccessibilityNode: Schema.Codec<SnapShotAccessibilityNode> = Schema.Struct({
  role: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1_000))),
  value: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  bounds: Schema.NullOr(SnapShotAccessibilityBounds),
  state: Schema.optionalKey(SnapShotAccessibilityState),
  actions: Schema.optionalKey(
    Schema.mutable(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(100)))).check(
      Schema.isMaxLength(32),
    ),
  ),
  children: Schema.mutable(
    Schema.Array(
      Schema.suspend((): Schema.Codec<SnapShotAccessibilityNode> => SnapShotAccessibilityNode),
    ),
  ).check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBILITY_MAX_NODES)),
});

const SnapShotAccessibilityWire = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("flat-text"),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    format: Schema.Literal("element-tree"),
    coordinateSpace: Schema.Literal("captured-image"),
    imageSize: Schema.Struct({ width: PositiveInt, height: PositiveInt }),
    truncated: Schema.Boolean,
    root: SnapShotAccessibilityNode,
  }),
]);
export const SnapShotAccessibility = SnapShotAccessibilityWire.check(
  Schema.makeFilter((accessibility: typeof SnapShotAccessibilityWire.Type) => {
    if (accessibility.format === "flat-text") return undefined;
    let nodes = 0;
    const stack = [accessibility.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      nodes += 1;
      if (nodes > SNAP_SHOT_ACCESSIBILITY_MAX_NODES) {
        return `Accessibility trees must not exceed ${SNAP_SHOT_ACCESSIBILITY_MAX_NODES} nodes.`;
      }
      stack.push(...node.children);
    }
    return (
      JSON.stringify(accessibility).length <= SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS ||
      `Accessibility trees must not exceed ${SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS} serialized characters.`
    );
  }),
);
export type SnapShotAccessibility = typeof SnapShotAccessibility.Type;

export const SnapShotCaptureType = Schema.Literals(["window", "screen", "region"]);
export type SnapShotCaptureType = typeof SnapShotCaptureType.Type;

export const SnapShotSource = Schema.Struct({
  kind: Schema.Literal("snap-shot"),
  capturedAt: IsoDateTime,
  captureType: Schema.optional(SnapShotCaptureType),
  /** Capture rectangle in desktop logical coordinates; origins may be negative. */
  captureBounds: Schema.optional(
    Schema.Struct({
      x: Schema.Number.check(Schema.isFinite()),
      y: Schema.Number.check(Schema.isFinite()),
      width: PositiveInt,
      height: PositiveInt,
    }),
  ),
  appName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  windowTitle: TrimmedString.check(Schema.isMaxLength(1_000)),
  accessibleText: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)),
  ),
  accessibility: Schema.optional(SnapShotAccessibility),
  appIdentifier: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  appIconDataUrl: Schema.optional(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(100_000),
      Schema.isPattern(/^data:image\/png;base64,/i),
    ),
  ),
});
export type SnapShotSource = typeof SnapShotSource.Type;
