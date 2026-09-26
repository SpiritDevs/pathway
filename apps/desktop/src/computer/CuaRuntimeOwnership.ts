// @effect-diagnostics nodeBuiltinImport:off -- Ownership checks need lstat, O_NOFOLLOW and fstat, which the Effect FileSystem does not expose.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const MARKER_NAME = ".pathway-cua-runtime.json";
const MARKER_SCHEMA = "pathway-cua-runtime";
const RUNTIME_DIRECTORY = /^pathway-cua-[a-zA-Z0-9]{6}$/;
const STALE_AFTER_MS = 30_000;

const CuaRuntimeMarkerJson = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal(MARKER_SCHEMA),
    version: Schema.Literal(1),
    directory: Schema.String,
    hostPid: Schema.Number,
    ownerUid: Schema.NullOr(Schema.Number),
    createdAt: Schema.Number,
  }),
);
const encodeMarker = Schema.encodeSync(CuaRuntimeMarkerJson);
const decodeMarker = Schema.decodeUnknownOption(CuaRuntimeMarkerJson);

export class CuaRuntimeOwnershipError extends Schema.TaggedErrorClass<CuaRuntimeOwnershipError>()(
  "CuaRuntimeOwnershipError",
  { directory: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not mark the Cua runtime directory ${this.directory} as owned.`;
  }
}

/** EPERM and other probe errors are not proof that the owner died. */
export function cuaHostProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Writes the private ownership marker that later permits a stale-runtime sweep. */
export const markCuaRuntimeDirectory = Effect.fn("markCuaRuntimeDirectory")(function* (
  directory: string,
) {
  const createdAt = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise({
    try: () =>
      NodeFS.promises.writeFile(
        NodePath.join(directory, MARKER_NAME),
        encodeMarker({
          schema: MARKER_SCHEMA,
          version: 1,
          directory: NodePath.basename(directory),
          hostPid: process.pid,
          ownerUid: process.getuid?.() ?? null,
          createdAt,
        }) + "\n",
        { mode: 0o600, flag: "wx" },
      ),
    catch: (cause) => new CuaRuntimeOwnershipError({ directory, cause }),
  });
});

/** Only explicit private runtime ownership permits recursive cleanup. Similar
 * prefixes, legacy unmarked directories, and a lazy live host are preserved. */
export const sweepOwnedCuaRuntimeDirectories = Effect.fn("sweepOwnedCuaRuntimeDirectories")(
  function* (options: {
    readonly directory: string;
    readonly liveSocketDirs: ReadonlySet<string>;
    readonly isProcessAlive?: (pid: number) => boolean;
  }) {
    const now = yield* Clock.currentTimeMillis;
    return sweepSync({ ...options, now });
  },
);

function sweepSync(options: {
  readonly directory: string;
  readonly liveSocketDirs: ReadonlySet<string>;
  readonly now: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}): string[] {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const { now } = options;
  const isProcessAlive = options.isProcessAlive ?? cuaHostProcessIsAlive;
  const protectedDirectories = new Set<string>();
  for (const path of options.liveSocketDirs) {
    try {
      protectedDirectories.add(NodeFS.realpathSync(path));
    } catch {
      protectedDirectories.add(path);
    }
  }
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(options.directory);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!RUNTIME_DIRECTORY.test(entry)) continue;
    const directory = NodePath.join(options.directory, entry);
    let markerFd: number | undefined;
    try {
      const before = NodeFS.lstatSync(directory);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        before.uid !== uid ||
        (before.mode & 0o077) !== 0 ||
        now - before.mtimeMs < STALE_AFTER_MS ||
        protectedDirectories.has(NodeFS.realpathSync(directory))
      )
        continue;
      markerFd = NodeFS.openSync(
        NodePath.join(directory, MARKER_NAME),
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      );
      const markerStat = NodeFS.fstatSync(markerFd);
      if (
        !markerStat.isFile() ||
        markerStat.uid !== uid ||
        markerStat.nlink !== 1 ||
        (markerStat.mode & 0o077) !== 0 ||
        markerStat.size <= 0 ||
        markerStat.size > 1_024
      )
        continue;
      const bytes = Buffer.alloc(1_025);
      const length = NodeFS.readSync(markerFd, bytes, 0, bytes.length, 0);
      if (length === 0 || length > 1_024) continue;
      const marker = decodeMarker(bytes.subarray(0, length).toString("utf8"));
      if (Option.isNone(marker)) continue;
      const data = marker.value;
      if (
        data.directory !== entry ||
        data.ownerUid !== uid ||
        !Number.isSafeInteger(data.hostPid) ||
        data.hostPid <= 0 ||
        data.hostPid > 0x7fffffff ||
        !Number.isFinite(data.createdAt) ||
        data.createdAt <= 0 ||
        now - data.createdAt < STALE_AFTER_MS ||
        isProcessAlive(data.hostPid)
      )
        continue;
      // Refuse replacement/symlink races between the ownership read and removal.
      const after = NodeFS.lstatSync(directory);
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        after.uid !== uid ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        (after.mode & 0o077) !== 0
      )
        continue;
      NodeFS.rmSync(directory, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Missing, malformed, unreadable, or changed ownership is not permission
      // to delete. A future sweep can reconsider a still-owned stale runtime.
    } finally {
      if (markerFd !== undefined) NodeFS.closeSync(markerFd);
    }
  }
  return removed;
}
