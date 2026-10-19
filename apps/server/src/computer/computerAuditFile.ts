/**
 * Bounded, link-refusing reads of the local Computer audit log, shared by the
 * activity history and the log's own retention.
 *
 * @module computer/computerAuditFile
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Why the activity history could not be read; the message is safe to show. */
export class ComputerAuditHistoryError extends Schema.TaggedErrorClass<ComputerAuditHistoryError>()(
  "ComputerAuditHistoryError",
  { message: Schema.String },
) {}

export interface ComputerAuditFileTail {
  readonly contents: Buffer;
  readonly start: number;
  readonly totalBytes: number;
  readonly requestedBytes: number;
  readonly device: number;
  readonly inode: number;
}

const unreadable = () =>
  new ComputerAuditHistoryError({ message: "Could not read Computer activity history." });

/** A symbolic link is refused, never followed; an absent path reads as `null`. */
const refuseLink = (fs: FileSystem.FileSystem, path: string) =>
  fs.readLink(path).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.fail(unreadable()),
      onFailure: (error) =>
        Effect.succeed(error.reason._tag === "NotFound" ? ("missing" as const) : ("file" as const)),
    }),
  );

/** Shared bounded file access for audit history and retention, never a full-file read. */
export const readComputerAuditFileTail = Effect.fn("readComputerAuditFileTail")(function* (
  path: string,
  maxBytes: number,
): Effect.fn.Return<
  ComputerAuditFileTail | null,
  ComputerAuditHistoryError,
  FileSystem.FileSystem
> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return yield* new ComputerAuditHistoryError({ message: "Invalid audit read bound." });
  }
  const fs = yield* FileSystem.FileSystem;
  // The platform file system cannot open with O_NOFOLLOW or O_NONBLOCK. Refuse
  // links and non-regular files before opening, then verify the opened
  // identity so a link swapped in meanwhile cannot substitute another file.
  if ((yield* refuseLink(fs, path)) === "missing") return null;
  const entry = yield* fs.stat(path).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(unreadable()),
    ),
  );
  if (Option.isNone(entry)) return null;
  if (entry.value.type !== "File") return yield* unreadable();

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path, { flag: "r" });
      const stat = yield* file.stat;
      yield* refuseLink(fs, path);
      const current = yield* fs.stat(path);
      const inode = Option.getOrUndefined(stat.ino);
      if (
        stat.type !== "File" ||
        current.type !== "File" ||
        current.dev !== stat.dev ||
        Option.getOrUndefined(current.ino) !== inode
      ) {
        return yield* unreadable();
      }
      const size = Number(stat.size);
      const length = Math.min(size, maxBytes);
      const start = size - length;
      const buffer = Buffer.allocUnsafe(length);
      yield* file.seek(start, "start");
      let bytesRead = 0;
      while (bytesRead < length) {
        const read = Number(yield* file.read(buffer.subarray(bytesRead)));
        if (read === 0) break;
        bytesRead += read;
      }
      return {
        contents: buffer.subarray(0, bytesRead),
        start,
        totalBytes: size,
        requestedBytes: length,
        device: stat.dev,
        inode: inode ?? 0,
      };
    }),
  ).pipe(
    Effect.mapError((error) => (error._tag === "ComputerAuditHistoryError" ? error : unreadable())),
  );
});

/** Complete newline-terminated records, newest first, preserving their file positions. */
export function* computerAuditTailLines(tail: ComputerAuditFileTail): Generator<{
  readonly line: Buffer;
  readonly offset: number;
}> {
  const { contents, start } = tail;
  let end = contents.lastIndexOf(10);
  while (end >= 0) {
    const previous = end > 0 ? contents.lastIndexOf(10, end - 1) : -1;
    const lineStart = previous + 1;
    if (previous < 0 && start > 0) return;
    yield { line: contents.subarray(lineStart, end + 1), offset: start + lineStart };
    end = previous;
  }
}
