/**
 * Real registration hooks for the Convex sync smoke harness.
 *
 * `environmentRegistrations` rows have no public management API, so each hook
 * shells out to `npx convex run smoke:<fn> '<json-args>'` with the working
 * directory set to `packages/backend` — the internal-only seed/teardown module
 * built for this smoke test (`packages/backend/convex/smoke.ts`).
 *
 * The deployment is pinned, never inferred: left to itself the convex CLI
 * resolves its target from `packages/backend/.env.local` or an inherited
 * `CONVEX_DEPLOYMENT`, independent of the `CONVEX_URL` the harness's
 * authenticated client calls use — a mismatch would mutate a different (even
 * production) deployment. So the config names the deployment explicitly
 * (`PATHWAY_CONVEX_SMOKE_DEPLOYMENT`), every subprocess runs with
 * `CONVEX_DEPLOYMENT` overridden to it, and before ANY mutation
 * {@link checkConvexSmokeDeploymentTarget} cross-checks the deployment slug
 * against the first hostname label of `CONVEX_URL`, failing fast otherwise
 * (custom domains opt out via `PATHWAY_CONVEX_SMOKE_ALLOW_URL_MISMATCH=1`).
 *
 * `convex run` prints the function's return value as JSON on stdout;
 * {@link parseConvexRunOutput} strips any leading non-JSON log lines
 * defensively before parsing. Each hook then asserts the shape the smoke
 * functions promise (`seed` reports the reserved smoke company id,
 * `setThumbprint`/`revokeRegistration` report that the registration existed),
 * so a misconfigured deployment fails the hook step with an actionable message
 * instead of poisoning a later negative-case assertion.
 */
import * as NodeUrl from "node:url";

import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";
import { ConvexSyncSmokeHookError, type ConvexSyncSmokeHooks } from "./convexSyncSmoke.ts";

/** `packages/backend` resolved relative to this source file (repo checkout layout). */
export function defaultConvexSmokeBackendDir(): string {
  return NodeUrl.fileURLToPath(new URL("../../../../packages/backend", import.meta.url));
}

export type ParsedConvexRunOutput =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Extracts the JSON value `convex run` printed. The return value is the last
 * thing on stdout (possibly pretty-printed over multiple lines), but the CLI
 * may precede it with progress/log lines — so on a whole-stdout parse failure,
 * leading lines are dropped one at a time until a suffix parses.
 */
export function parseConvexRunOutput(stdout: string): ParsedConvexRunOutput {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "convex run printed nothing on stdout" };
  }
  const lines = trimmed.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n").trim();
    if (candidate.length === 0) {
      continue;
    }
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Leading log line — drop it and retry with the remaining suffix.
    }
  }
  return {
    ok: false,
    reason: `convex run stdout did not end in a JSON value: ${trimmed}`,
  };
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The `<slug>` of a `dev:<slug>` / `prod:<slug>` deployment identifier, or `null`. */
export function convexDeploymentSlug(deployment: string): string | null {
  const trimmed = deployment.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  const slug = trimmed.slice(colon + 1);
  return slug.length > 0 ? slug : null;
}

/**
 * The mutation-safety cross-check: the pinned deployment's slug must be the
 * first hostname label of the `CONVEX_URL` the authenticated client calls use
 * (e.g. `dev:chatty-ermine-52` ↔ `chatty-ermine-52.convex.cloud`), so the
 * admin hooks and the client provably target the same deployment. Returns
 * `null` when the pairing is safe, otherwise an actionable refusal.
 */
export function checkConvexSmokeDeploymentTarget(input: {
  readonly deployment: string;
  readonly convexUrl: string;
  readonly allowUrlMismatch: boolean;
}): string | null {
  const slug = convexDeploymentSlug(input.deployment);
  if (slug === null) {
    return `PATHWAY_CONVEX_SMOKE_DEPLOYMENT must name the target deployment as '<kind>:<slug>' (e.g. "dev:chatty-ermine-52"), got ${JSON.stringify(
      input.deployment,
    )}`;
  }
  let hostname: string;
  try {
    hostname = new URL(input.convexUrl).hostname;
  } catch {
    return `CONVEX_URL is not a parseable URL: ${JSON.stringify(input.convexUrl)}`;
  }
  if (hostname.split(".")[0] === slug) {
    return null;
  }
  if (input.allowUrlMismatch) {
    return null;
  }
  return `deployment '${input.deployment}' does not match CONVEX_URL host '${hostname}' (expected its first label to be '${slug}') — the admin hooks would mutate a different deployment than the authenticated client calls. If CONVEX_URL is a custom domain that can never match, set PATHWAY_CONVEX_SMOKE_ALLOW_URL_MISMATCH=1 to proceed.`;
}

export interface ConvexRunSmokeHooksConfig {
  /** The throwaway smoke environment id every `smoke:<fn>` call is keyed by. */
  readonly environmentId: string;
  /**
   * Company domain id the harness queries Convex with. `smoke:seed` reports the
   * reserved smoke company id it seeded; a mismatch fails the seed hook so the
   * run stops before any Convex step can fail for the wrong reason.
   */
  readonly companyId: string;
  /** Directory `npx convex run` executes in; see {@link defaultConvexSmokeBackendDir}. */
  readonly backendDir: string;
  /**
   * Convex deployment identifier every hook is pinned to, e.g.
   * `dev:chatty-ermine-52` (`PATHWAY_CONVEX_SMOKE_DEPLOYMENT`). Passed as
   * `CONVEX_DEPLOYMENT` in each subprocess's environment, overriding anything
   * inherited or read from `.env.local`.
   */
  readonly deployment: string;
  /** The `CONVEX_URL` the harness's client calls use; cross-checked against `deployment`. */
  readonly convexUrl: string;
  /** `PATHWAY_CONVEX_SMOKE_ALLOW_URL_MISMATCH=1` — required for custom domains. */
  readonly allowUrlMismatch?: boolean;
}

/** `npx` resolution plus a network round-trip to the deployment can be slow on first run. */
const CONVEX_RUN_TIMEOUT = "120 seconds";

/**
 * Builds {@link ConvexSyncSmokeHooks} backed by `npx convex run smoke:<fn>`
 * against whatever deployment the convex CLI resolves from `backendDir`.
 */
export const makeConvexRunSmokeHooks = Effect.fn("cloud.convex_sync_smoke.make_hooks")(function* (
  config: ConvexRunSmokeHooksConfig,
) {
  const runner = yield* ProcessRunner.ProcessRunner;

  const hookError = (hook: string, cause: unknown) => new ConvexSyncSmokeHookError({ hook, cause });

  // Refuse to build mutating hooks at all when the pinned deployment and the
  // client-facing CONVEX_URL disagree — fail fast, before ANY mutation.
  const targetMismatch = checkConvexSmokeDeploymentTarget({
    deployment: config.deployment,
    convexUrl: config.convexUrl,
    allowUrlMismatch: config.allowUrlMismatch === true,
  });
  if (targetMismatch !== null) {
    return yield* hookError("configuration", targetMismatch);
  }

  // Explicitly constructed subprocess environment: the inherited env rides
  // along (npx needs PATH, the convex CLI its auth), but CONVEX_DEPLOYMENT is
  // always ours, so the CLI can never resolve a different deployment from
  // `.env.local` or an inherited variable.
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...globalThis.process.env,
    CONVEX_DEPLOYMENT: config.deployment,
  };

  const runSmokeFunction = (
    hook: string,
    fn: string,
    args: Record<string, unknown>,
  ): Effect.Effect<unknown, ConvexSyncSmokeHookError> =>
    runner
      .run({
        command: "npx",
        args: ["convex", "run", `smoke:${fn}`, JSON.stringify(args)],
        cwd: config.backendDir,
        env: subprocessEnv,
        timeout: CONVEX_RUN_TIMEOUT,
      })
      .pipe(
        Effect.mapError((cause) => hookError(hook, cause)),
        Effect.flatMap((output) => {
          if (output.code !== 0) {
            return Effect.fail(
              hookError(
                hook,
                `\`npx convex run smoke:${fn}\` in ${config.backendDir} exited with code ${String(
                  output.code,
                )}: ${output.stderr.trim() || output.stdout.trim() || "(no output)"}`,
              ),
            );
          }
          const parsed = parseConvexRunOutput(output.stdout);
          return parsed.ok
            ? Effect.succeed(parsed.value)
            : Effect.fail(hookError(hook, `\`npx convex run smoke:${fn}\`: ${parsed.reason}`));
        }),
      );

  const seedRegistration = (thumbprint: string) =>
    runSmokeFunction("seedRegistration", "seed", {
      environmentId: config.environmentId,
      publicKeyThumbprint: thumbprint,
    }).pipe(
      Effect.flatMap((value) => {
        const seededCompanyId = fieldOf(value, "companyId");
        return seededCompanyId === config.companyId
          ? Effect.void
          : Effect.fail(
              hookError(
                "seedRegistration",
                `smoke:seed seeded company ${JSON.stringify(seededCompanyId)} but the harness targets ${JSON.stringify(
                  config.companyId,
                )} — point the harness at the reserved smoke company id`,
              ),
            );
      }),
    );

  const setRegistrationThumbprint = (thumbprint: string) =>
    runSmokeFunction("setRegistrationThumbprint", "setThumbprint", {
      environmentId: config.environmentId,
      publicKeyThumbprint: thumbprint,
    }).pipe(
      Effect.flatMap((value) =>
        fieldOf(value, "updated") === true
          ? Effect.void
          : Effect.fail(
              hookError(
                "setRegistrationThumbprint",
                `smoke:setThumbprint found no registration for environment ${config.environmentId}`,
              ),
            ),
      ),
    );

  const revokeRegistration = () =>
    runSmokeFunction("revokeRegistration", "revokeRegistration", {
      environmentId: config.environmentId,
    }).pipe(
      Effect.flatMap((value) =>
        fieldOf(value, "revoked") === true
          ? Effect.void
          : Effect.fail(
              hookError(
                "revokeRegistration",
                `smoke:revokeRegistration found no registration for environment ${config.environmentId}`,
              ),
            ),
      ),
    );

  // Cleanup deletes (never restores); any converged result — including "already
  // gone" — is success.
  const cleanupRegistration = () =>
    runSmokeFunction("cleanupRegistration", "cleanup", {
      environmentId: config.environmentId,
    }).pipe(Effect.asVoid);

  return {
    seedRegistration,
    setRegistrationThumbprint,
    revokeRegistration,
    cleanupRegistration,
  } satisfies ConvexSyncSmokeHooks;
});
