import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

const PARENT_CHECK_INTERVAL = Duration.seconds(1);

export function hasDesktopParentExited(
  expectedParentPid: number,
  currentParentPid: number,
): boolean {
  return currentParentPid !== expectedParentPid;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const expectedParentPid = config.desktopParentPid;
    if (config.mode !== "desktop" || expectedParentPid === undefined) return;

    yield* Effect.forever(
      Effect.sleep(PARENT_CHECK_INTERVAL).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!hasDesktopParentExited(expectedParentPid, process.ppid)) return;
            process.kill(process.pid, "SIGTERM");
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);
  }),
);
