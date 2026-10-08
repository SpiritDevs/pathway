// @effect-diagnostics nodeBuiltinImport:off - Dev-only bootstrap: a random deploy key for a loopback engine.
/**
 * A checkout-local Cyndrbase backend for `vp run dev`.
 *
 * Its data lives in a Postgres cluster under `<checkout>/.pathway/cyndrbase`, never a shared
 * developer database, and survives restarts; delete that directory for a fresh database. A loopback
 * `cyndrd` engine serves it, and `cyndr deploy` pushes packages/backend on every start because the
 * local engine keeps code in memory. Cyndrbase is linked from a source checkout until it publishes,
 * so `cyndrd` comes from that checkout's cargo build.
 *
 * Each start writes `cyndr.env` beside the data, so `cyndr run`, `cyndr env` and `psql` can reach
 * the running backend: `node --env-file=.pathway/cyndrbase/cyndr.env <cyndr> run smoke:inspect`.
 */
import * as NodeCrypto from "node:crypto";

import * as NetService from "@spiritdevs/shared/Net";
import { clerkFrontendApiUrlFromPublishableKey } from "@spiritdevs/shared/relayAuth";
import { normalizeRelayIssuer } from "@spiritdevs/shared/relayJwt";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DEPLOYMENT = "pathway";

export class LocalCyndrbaseError extends Schema.TaggedErrorClass<LocalCyndrbaseError>()(
  "LocalCyndrbaseError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface LocalCyndrbaseEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * The deployment settings `auth.config.ts` and the functions read, derived from the public config
 * the clients use, or `undefined` when cloud sync is not configured (no Clerk or relay). Explicit
 * values win, for example a relay issuer backed by a locally generated key.
 */
export function resolveLocalCyndrbaseEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): LocalCyndrbaseEnvironment | undefined {
  const value = (name: string) => env[name]?.trim() || undefined;
  let clerkIssuer = value("CLERK_JWT_ISSUER_DOMAIN");
  const clerkKey = value("PATHWAY_CLERK_PUBLISHABLE_KEY");
  if (clerkIssuer === undefined && clerkKey !== undefined) {
    try {
      clerkIssuer = clerkFrontendApiUrlFromPublishableKey(clerkKey);
    } catch {
      clerkIssuer = undefined;
    }
  }
  const relayUrl = value("PATHWAY_RELAY_URL");
  const relayIssuer =
    value("PATHWAY_RELAY_JWT_ISSUER") ?? (relayUrl ? normalizeRelayIssuer(relayUrl) : undefined);
  if (clerkIssuer === undefined || relayIssuer === undefined) {
    return undefined;
  }
  const optional = (...names: ReadonlyArray<string>) =>
    Object.fromEntries(names.flatMap((name) => (value(name) ? [[name, value(name)!]] : [])));
  return {
    values: {
      CLERK_JWT_ISSUER_DOMAIN: clerkIssuer,
      PATHWAY_RELAY_JWT_ISSUER: relayIssuer,
      PATHWAY_RELAY_JWKS_URL:
        value("PATHWAY_RELAY_JWKS_URL") ?? `${relayIssuer}/.well-known/jwks.json`,
      ...optional("PATHWAY_RELAY_JWT_ADDITIONAL_ISSUERS"),
    },
    secrets: optional("RESEND_API_KEY", "UPLOADTHING_TOKEN"),
  };
}

const failure = (reason: string) => new LocalCyndrbaseError({ reason });
const isLocalCyndrbaseError = Schema.is(LocalCyndrbaseError);

/** Runs a command to completion, failing with its output when it exits non-zero. */
const run = (command: ChildProcess.Command, label: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(command);
    const [output, exitCode] = yield* Effect.all(
      [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* failure(`${label} exited with code ${exitCode}:\n${output.trim()}`);
    }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      isLocalCyndrbaseError(error) ? error : failure(`${label} failed: ${error.message}`),
    ),
  );

/**
 * Starts a process for the life of the scope, echoing its output, and waits until `ready` accepts
 * one of its lines. Exiting first is a failure.
 */
const start = (command: ChildProcess.Command, label: string, ready: (line: string) => boolean) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(command);
    const started = yield* Deferred.make<void>();
    yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => process.stderr.write(`[${label}] ${line}\n`)).pipe(
          Effect.andThen(ready(line) ? Deferred.succeed(started, undefined) : Effect.void),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(started).pipe(
      Effect.raceFirst(
        handle.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.fail(failure(`${label} exited with code ${code} before it was ready.`)),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.mapError((error) =>
      isLocalCyndrbaseError(error) ? error : failure(`${label} failed: ${error.message}`),
    ),
  );

/** `PG_BIN`, then `pg_config --bindir`, then Homebrew's Postgres 17, as Cyndrbase's testkit does. */
const postgresBin = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const configured = env.PG_BIN?.trim();
    if (configured) {
      return configured;
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bindir = yield* spawner
      .string(ChildProcess.make("pg_config", ["--bindir"]))
      .pipe(Effect.orElseSucceed(() => ""));
    return bindir.trim() || "/opt/homebrew/opt/postgresql@17/bin";
  });

/** Starts Postgres and `cyndrd` for the scope, configures and deploys the backend, and returns its URLs. */
export const startLocalCyndrbase = Effect.fn("startLocalCyndrbase")(function* (input: {
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly deployment: LocalCyndrbaseEnvironment;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const backend = path.join(input.repoRoot, "packages/backend");
  const cli = path.join(backend, "node_modules/@cyndrbase/cli");
  const checkout = path.resolve(
    yield* fs.realPath(cli).pipe(Effect.mapError(() => failure(`${cli} is missing; run vp i.`))),
    "../..",
  );
  const cyndrd = path.join(checkout, "target/debug/cyndrd");
  if (!(yield* fs.exists(cyndrd).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* failure(
      `${cyndrd} is missing. Build it with \`cargo build -p cyndrd -p cyndrbase-isolate --bins\` in ${checkout}.`,
    );
  }

  const bin = yield* postgresBin(input.env);
  const root = path.join(input.repoRoot, ".pathway/cyndrbase");
  const data = path.join(root, "postgres");
  if (!(yield* fs.exists(path.join(data, "PG_VERSION")).pipe(Effect.orElseSucceed(() => false)))) {
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError((error) => failure(error.message)));
    yield* run(
      ChildProcess.make(path.join(bin, "initdb"), [
        "--auth=trust",
        "--username=postgres",
        "--encoding=UTF8",
        "--no-locale",
        "-D",
        data,
      ]),
      "initdb",
    );
  }
  const port = yield* net
    .reserveLoopbackPort()
    .pipe(Effect.mapError((error) => failure(error.message)));
  yield* start(
    ChildProcess.make(
      path.join(bin, "postgres"),
      ["-D", data, "-h", "127.0.0.1", "-p", String(port), "-k", ""],
      // Fast shutdown: smart shutdown would wait on clients that are exiting with us.
      { env: { LC_ALL: "C" }, extendEnv: true, killSignal: "SIGINT", forceKillAfter: "5 seconds" },
    ),
    "postgres",
    (line) => line.includes("database system is ready to accept connections"),
  );

  const keyFile = path.join(root, "deploy-key");
  const key = yield* fs.readFileString(keyFile).pipe(
    Effect.catch(() => {
      const created = NodeCrypto.randomBytes(32).toString("hex");
      return fs.writeFileString(keyFile, created, { mode: 0o600 }).pipe(Effect.as(created));
    }),
    Effect.mapError((error) => failure(error.message)),
  );
  const databaseUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  let url: string | undefined;
  let siteUrl: string | undefined;
  yield* start(
    ChildProcess.make(
      cyndrd,
      [
        "--role",
        "engine",
        "--local-deploy",
        "--listen",
        "127.0.0.1:0",
        "--http-actions-listen",
        "127.0.0.1:0",
        "--deployment",
        DEPLOYMENT,
        ...(input.env.CYNDRBASE_FILES_CONFIG
          ? ["--files-config", input.env.CYNDRBASE_FILES_CONFIG]
          : []),
      ],
      {
        env: {
          CYNDRBASE_DATABASE_URL: databaseUrl,
          CYNDRBASE_DEPLOY_KEY: key,
          RUST_LOG: input.env.RUST_LOG ?? "warn",
        },
        extendEnv: true,
        forceKillAfter: "5 seconds",
      },
    ),
    "cyndrbase",
    (line) => {
      url ??= /^\{"origin":"([^"]+)"\}$/u.exec(line)?.[1];
      siteUrl ??= /^\{"httpActionsOrigin":"([^"]+)"\}$/u.exec(line)?.[1];
      return url !== undefined && siteUrl !== undefined;
    },
  );
  if (url === undefined || siteUrl === undefined) {
    return yield* failure("cyndrd did not report its origins.");
  }

  const cyndr = (args: ReadonlyArray<string>) =>
    run(
      ChildProcess.make(process.execPath, [path.join(cli, "dist/cyndr.js"), ...args], {
        cwd: backend,
        env: { CYNDRBASE_URL: url, CYNDRBASE_DEPLOYMENT: DEPLOYMENT, CYNDRBASE_DEPLOY_KEY: key },
        extendEnv: true,
      }),
      `cyndr ${args.slice(0, 3).join(" ")}`,
    );
  // Convex sets CONVEX_SITE_URL itself; Cyndrbase leaves it to the deployment's environment.
  for (const [name, value] of Object.entries({
    ...input.deployment.values,
    CONVEX_SITE_URL: siteUrl,
  })) {
    yield* cyndr(["env", "set", name, value]);
  }
  for (const [name, value] of Object.entries(input.deployment.secrets)) {
    yield* cyndr(["env", "set", name, value, "--secret"]);
  }
  yield* cyndr(["deploy", "--yes"]);
  yield* fs
    .writeFileString(
      path.join(root, "cyndr.env"),
      `CYNDRBASE_URL=${url}\nCYNDRBASE_DEPLOYMENT=${DEPLOYMENT}\nCYNDRBASE_DEPLOY_KEY=${key}\nCYNDRBASE_DATABASE_URL=${databaseUrl}\n`,
      { mode: 0o600 },
    )
    .pipe(Effect.mapError((error) => failure(error.message)));
  return { url, siteUrl };
});
