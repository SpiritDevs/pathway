/**
 * Real registration hooks for the Cyndrbase sync smoke harness.
 *
 * `environmentRegistrations` rows have no public management API, so each hook
 * shells out to `cyndr run smoke:<fn> '<json-args>'` with the working directory
 * set to `packages/backend` — the internal-only seed/teardown module built for
 * this smoke test (`packages/backend/convex/smoke.ts`). `cyndr` authenticates
 * with the inherited `CYNDRBASE_URL` and `CYNDRBASE_DEPLOY_KEY`.
 *
 * The deployment is pinned, never inferred: the config names it explicitly
 * (`PATHWAY_CYNDRBASE_SMOKE_DEPLOYMENT`), every subprocess runs with
 * `CYNDRBASE_DEPLOYMENT` overridden to it, and before ANY mutation
 * {@link checkConvexSmokeDeploymentTarget} cross-checks it against the first
 * hostname label of the deployment URL the harness's authenticated client calls
 * use, failing fast otherwise (custom domains and local engines opt out via
 * `PATHWAY_CYNDRBASE_SMOKE_ALLOW_URL_MISMATCH=1`).
 *
 * `cyndr run` prints the function's return value as JSON on stdout;
 * {@link parseConvexRunOutput} strips any leading non-JSON log lines
 * defensively before parsing. Each hook then asserts the shape the smoke
 * functions promise (`seed` reports the reserved smoke company id,
 * `setThumbprint`/`revokeRegistration` report that the registration existed),
 * so a misconfigured deployment fails the hook step with an actionable message
 * instead of poisoning a later negative-case assertion.
 */
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";
import { ConvexSyncSmokeHookError, type ConvexSyncSmokeHooks } from "./convexSyncSmoke.ts";

/** `packages/backend` resolved relative to this source file (repo checkout layout). */
export function defaultConvexSmokeBackendDir(): string {
  return NodeURL.fileURLToPath(new URL("../../../../packages/backend", import.meta.url));
}

export type ParsedConvexRunOutput =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Extracts the JSON value `cyndr run` printed. The return value is the last
 * thing on stdout (possibly pretty-printed over multiple lines), but the CLI
 * may precede it with progress/log lines — so on a whole-stdout parse failure,
 * leading lines are dropped one at a time until a suffix parses.
 */
export function parseConvexRunOutput(stdout: string): ParsedConvexRunOutput {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "cyndr run printed nothing on stdout" };
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
    reason: `cyndr run stdout did not end in a JSON value: ${trimmed}`,
  };
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The mutation-safety cross-check: the pinned deployment must be the first
 * hostname label of the deployment URL the authenticated client calls use
 * (`pathway-dev` ↔ `pathway-dev.syd.cyndrbase.cloud`), so the admin hooks and
 * the client provably target the same deployment. Returns `null` when the
 * pairing is safe, otherwise an actionable refusal.
 */
export function checkConvexSmokeDeploymentTarget(input: {
  readonly deployment: string;
  readonly convexUrl: string;
  readonly allowUrlMismatch: boolean;
}): string | null {
  const deployment = input.deployment.trim();
  if (deployment.length === 0) {
    return `PATHWAY_CYNDRBASE_SMOKE_DEPLOYMENT must name the target deployment (e.g. "pathway-dev"), got ${JSON.stringify(
      input.deployment,
    )}`;
  }
  let hostname: string;
  try {
    hostname = new URL(input.convexUrl).hostname;
  } catch {
    return `PATHWAY_CYNDRBASE_URL is not a parseable URL: ${JSON.stringify(input.convexUrl)}`;
  }
  if (hostname.split(".")[0] === deployment || input.allowUrlMismatch) {
    return null;
  }
  return `deployment '${deployment}' does not match the deployment URL host '${hostname}' (expected its first label to be '${deployment}') — the admin hooks would mutate a different deployment than the authenticated client calls. If the URL is a custom domain or a local engine that can never match, set PATHWAY_CYNDRBASE_SMOKE_ALLOW_URL_MISMATCH=1 to proceed.`;
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
  /** Directory `cyndr run` executes in; see {@link defaultConvexSmokeBackendDir}. */
  readonly backendDir: string;
  /**
   * Cyndrbase deployment every hook is pinned to, e.g. `pathway-dev`
   * (`PATHWAY_CYNDRBASE_SMOKE_DEPLOYMENT`). Passed as `CYNDRBASE_DEPLOYMENT` in
   * each subprocess's environment, overriding anything inherited.
   */
  readonly deployment: string;
  /** The deployment URL the harness's client calls use; cross-checked against `deployment`. */
  readonly convexUrl: string;
  /** `PATHWAY_CYNDRBASE_SMOKE_ALLOW_URL_MISMATCH=1` — required for custom domains and local engines. */
  readonly allowUrlMismatch?: boolean;
}

/** A network round-trip to the deployment can be slow on first run. */
const CONVEX_RUN_TIMEOUT = "120 seconds";

/**
 * Builds {@link ConvexSyncSmokeHooks} backed by `cyndr run smoke:<fn>` against
 * the pinned deployment.
 */
export const makeConvexRunSmokeHooks = Effect.fn("cloud.convex_sync_smoke.make_hooks")(function* (
  config: ConvexRunSmokeHooksConfig,
) {
  const runner = yield* ProcessRunner.ProcessRunner;

  const hookError = (hook: string, cause: unknown) => new ConvexSyncSmokeHookError({ hook, cause });

  // Refuse to build mutating hooks at all when the pinned deployment and the
  // client-facing deployment URL disagree — fail fast, before ANY mutation.
  const targetMismatch = checkConvexSmokeDeploymentTarget({
    deployment: config.deployment,
    convexUrl: config.convexUrl,
    allowUrlMismatch: config.allowUrlMismatch === true,
  });
  if (targetMismatch !== null) {
    return yield* hookError("configuration", targetMismatch);
  }

  // Explicitly constructed subprocess environment: the inherited env rides
  // along (PATH, CYNDRBASE_URL and CYNDRBASE_DEPLOY_KEY), but
  // CYNDRBASE_DEPLOYMENT is always ours, so the CLI can never target a
  // different deployment from an inherited variable.
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...globalThis.process.env,
    CYNDRBASE_DEPLOYMENT: config.deployment,
  };
  // The backend's own devDependency, never an `npx` registry lookup.
  const cyndr = `${config.backendDir}/node_modules/.bin/cyndr`;

  const runSmokeFunction = (
    hook: string,
    fn: string,
    args: Record<string, unknown>,
  ): Effect.Effect<unknown, ConvexSyncSmokeHookError> =>
    runner
      .run({
        command: cyndr,
        args: ["run", `smoke:${fn}`, JSON.stringify(args)],
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
                `\`cyndr run smoke:${fn}\` in ${config.backendDir} exited with code ${String(
                  output.code,
                )}: ${output.stderr.trim() || output.stdout.trim() || "(no output)"}`,
              ),
            );
          }
          const parsed = parseConvexRunOutput(output.stdout);
          return parsed.ok
            ? Effect.succeed(parsed.value)
            : Effect.fail(hookError(hook, `\`cyndr run smoke:${fn}\`: ${parsed.reason}`));
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
