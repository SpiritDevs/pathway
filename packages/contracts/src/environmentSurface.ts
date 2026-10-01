import { Schema } from "effect";
import { ThreadId } from "./baseSchemas.ts";
import { ComputerSurfaceTarget } from "./computerSurface.ts";
import { PreviewTabId } from "./preview.ts";

export const ENVIRONMENT_SURFACE_WS_PATH = "/ws/environment-surface";
export const EnvironmentSurfaceSizing = Schema.Literals(["active", "passive"]);
export type EnvironmentSurfaceSizing = typeof EnvironmentSurfaceSizing.Type;
export const BrowserSurfaceTarget = Schema.Struct({
  kind: Schema.Literal("browser"),
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export const EnvironmentSurfaceTarget = Schema.Union([BrowserSurfaceTarget, ComputerSurfaceTarget]);
export type EnvironmentSurfaceTarget = typeof EnvironmentSurfaceTarget.Type;
export const EnvironmentSurfaceViewport = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 })),
  deviceScale: Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 4 })),
});
export type EnvironmentSurfaceViewport = typeof EnvironmentSurfaceViewport.Type;
