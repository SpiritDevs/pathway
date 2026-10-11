import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DEFAULT_CLIENT_SETTINGS } from "@spiritdevs/contracts";

import * as BrowserExtensions from "./BrowserExtensions.ts";
import * as BrowserSession from "./BrowserSession.ts";

const layerWithSession = (previewSession: Session) =>
  BrowserExtensions.layer.pipe(
    Layer.provide(
      Layer.mock(BrowserSession.BrowserSession)({
        onSession: (hook) => Effect.sync(() => hook(previewSession)),
        isPartition: () => false,
        settings: () => DEFAULT_CLIENT_SETTINGS,
        applyPagePolicy: () => {},
        markAgentActivity: () => {},
        isAgentActive: () => false,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

describe("BrowserExtensions", () => {
  it.effect("configures without failing when the runtime has no extensions API", () =>
    Effect.gen(function* () {
      const extensions = yield* BrowserExtensions.BrowserExtensions;
      yield* extensions.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        browserExtensions: [{ path: "/extensions/example", enabled: true }],
      });

      const [extension] = yield* extensions.list();
      assert.strictEqual(extension?.loaded, false);
      assert.strictEqual(extension?.id, null);
    }).pipe(Effect.provide(layerWithSession({} as Session))),
  );
});
