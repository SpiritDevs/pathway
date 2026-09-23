import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** What the primary backend needs to reach the desktop Computer host. */
export interface DesktopComputerHandoff {
  readonly endpoint: string;
  readonly capability: string;
}

export interface DesktopComputerService {
  /** Present only while a host is listening. */
  readonly handoff: Option.Option<DesktopComputerHandoff>;
  /** The backend is stopping: reject new work and retire the driver. */
  readonly suspend: Effect.Effect<void>;
  /** A backend is starting against this host again. */
  readonly resume: Effect.Effect<void>;
}

/**
 * The desktop Computer host as the backend lifecycle sees it. Inert unless the
 * Computer layer provides a live host, so backends start exactly as before.
 */
export const DesktopComputer = Context.Reference<DesktopComputerService>(
  "@spiritdevs/desktop/computer/DesktopComputer",
  {
    defaultValue: () => ({
      handoff: Option.none(),
      suspend: Effect.void,
      resume: Effect.void,
    }),
  },
);
