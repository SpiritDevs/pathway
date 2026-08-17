/**
 * Env-gated relay-flow smoke run against a REAL deployed relay and Convex
 * deployment. Entirely skipped unless `PATHWAY_CONVEX_SMOKE=1`.
 *
 * Required environment for a live run:
 * - `PATHWAY_CONVEX_SMOKE=1` — enables the suite.
 * - `CONVEX_URL` — Convex deployment URL (the one the relay mints
 *   `pathway-convex` tokens for).
 * - `PATHWAY_CONVEX_SMOKE_DEPLOYMENT` — the Convex deployment identifier the
 *   admin hooks are pinned to, e.g. `dev:chatty-ermine-52`. Passed to every
 *   `npx convex run` subprocess as `CONVEX_DEPLOYMENT` (overriding anything
 *   inherited or in `.env.local`) and cross-checked against `CONVEX_URL`'s
 *   hostname before any mutation.
 * - `PATHWAY_CONVEX_SMOKE_ALLOW_URL_MISMATCH=1` — optional; only for custom
 *   domains whose hostname can never match the deployment slug.
 * - `PATHWAY_RELAY_URL` — optional, defaults to `https://relay.spiritdevs.com`.
 * - `PATHWAY_CONVEX_SMOKE_COMPANY_ID` — optional, defaults to the reserved
 *   smoke company id that `smoke:seed` always creates.
 * - `PATHWAY_CONVEX_SMOKE_BACKEND_DIR` — optional, defaults to the repo's
 *   `packages/backend` resolved relative to this file.
 *
 * A stored Pathway Connect CLI credential must exist on this machine
 * (`pathway connect login`), and `npx convex run` must be authenticated for the
 * target deployment when executed from `packages/backend`. The registration
 * hooks shell out to the internal-only `smoke:*` functions in
 * `packages/backend/convex/smoke.ts`; see `./convexSmokeHooks.ts`.
 *
 * Runs that die before their own cleanup leave a recovery state file under
 * `defaultSmokeStateDir()`; the next run recovers those leftovers (relay
 * unlink + registration cleanup) before proceeding.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SMOKE_COMPANY_DOMAIN_ID } from "@spiritdevs/backend/smokeSeed";
import * as NetService from "@spiritdevs/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveCliAuthConfig } from "../cli/config.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import { defaultConvexSmokeBackendDir, makeConvexRunSmokeHooks } from "./convexSmokeHooks.ts";
import {
  defaultSmokeStateDir,
  makeSmokeEnvironmentId,
  renderConvexSyncSmokeReport,
  runConvexSyncSmoke,
} from "./convexSyncSmoke.ts";

const SMOKE_ENABLED = process.env.PATHWAY_CONVEX_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("convex sync relay-flow smoke (live)", () => {
  it("exercises CLI credential → link → key-binding exchange → Convex → negatives → cleanup", async () => {
    const relayBaseUrl = process.env.PATHWAY_RELAY_URL ?? "https://relay.spiritdevs.com";
    const convexUrl = process.env.CONVEX_URL;
    const deployment = process.env.PATHWAY_CONVEX_SMOKE_DEPLOYMENT;
    const allowUrlMismatch = process.env.PATHWAY_CONVEX_SMOKE_ALLOW_URL_MISMATCH === "1";
    const companyId = process.env.PATHWAY_CONVEX_SMOKE_COMPANY_ID ?? SMOKE_COMPANY_DOMAIN_ID;
    const backendDir =
      process.env.PATHWAY_CONVEX_SMOKE_BACKEND_DIR ?? defaultConvexSmokeBackendDir();
    assert.isDefined(convexUrl, "CONVEX_URL must be set for the Convex sync smoke run");
    assert.isDefined(
      deployment,
      'PATHWAY_CONVEX_SMOKE_DEPLOYMENT must name the deployment the admin hooks may mutate (e.g. "dev:chatty-ermine-52")',
    );
    if (convexUrl === undefined || deployment === undefined) {
      return;
    }

    // Same runtime wiring `pathway connect` commands use, minus the pieces the
    // smoke never touches (relay client binary, boot service, prompts).
    const program = Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig({ baseDir: Option.none() }, Option.none());
      const runtimeLayer = Layer.mergeAll(
        ServerSecretStore.layer,
        CliTokenManager.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ExternalLauncher.layer),
        ),
      ).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(ServerConfig.layer(config)),
      );
      const environmentId = makeSmokeEnvironmentId();
      const hooks = yield* makeConvexRunSmokeHooks({
        environmentId,
        companyId,
        backendDir,
        deployment,
        convexUrl,
        allowUrlMismatch,
      }).pipe(Effect.provide(ProcessRunner.layer));
      return yield* runConvexSyncSmoke({
        relayBaseUrl,
        convexUrl,
        deployment,
        stateDir: defaultSmokeStateDir(),
        companyId,
        environmentId,
        hooks,
      }).pipe(Effect.provide(runtimeLayer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)));

    const report = await Effect.runPromise(program);
    assert.isTrue(report.ok, `\n${renderConvexSyncSmokeReport(report)}`);
  }, 600_000);
});
