import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Data from "effect/Data";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as Effect from "effect/Effect";
import { ThreadId, type OrchestrationV2ThreadProjection } from "@spiritdevs/contracts";
import type { OrchestratorPendingInspection } from "@spiritdevs/contracts/orchestratorInspection";

const RESULT_LIMIT = 16000;
const bounded = (text: string) =>
  text.length <= RESULT_LIMIT
    ? text
    : text.slice(0, RESULT_LIMIT - 100) +
      "\n[Excerpt shortened. Request the next page or a narrower read.]";

export class InspectionError extends Data.TaggedError("InspectionError")<{
  readonly reason: string;
}> {}

export const readProjectInspection = Effect.fn("orchestrator.readProjectInspection")(function* (
  root: string,
  request: Extract<OrchestratorPendingInspection["request"], { kind: "readFile" | "listFiles" }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realRoot = yield* fs.realPath(root);
  const realTarget = yield* fs.realPath(path.resolve(realRoot, request.path || "."));
  const relative = path.relative(realRoot, realTarget);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((part) => [".git", ".pathway"].includes(part))
  )
    return yield* new InspectionError({
      reason: "Read a file or directory inside the selected project.",
    });
  if (request.kind === "listFiles") {
    const entries = (yield* fs.readDirectory(realTarget))
      .filter((entry) => ![".git", ".pathway", "node_modules"].includes(entry))
      .sort();
    return bounded(
      `Directory: ${relative || "."}\n${entries.slice(0, 200).join("\n")}\n${entries.length > 200 ? "[First 200 entries; choose a subdirectory.]" : "[End of directory]"}`,
    );
  }
  const info = yield* fs.stat(realTarget);
  if (info.type !== "File")
    return yield* new InspectionError({ reason: "Choose a regular text file." });
  const file = yield* fs.open(realTarget, { flag: "r" });
  const buffer = new Uint8Array(Math.min(Number(info.size), 1024 * 1024));
  const bytesRead = Number(yield* file.read(buffer));
  if (buffer.subarray(0, bytesRead).includes(0))
    return yield* new InspectionError({ reason: "Binary files cannot be read as text." });
  const lines = new TextDecoder().decode(buffer.subarray(0, bytesRead)).split("\n");
  const first = Math.max(1, request.startLine ?? 1);
  const selected = lines.slice(first - 1, first + 199);
  return bounded(
    `File: ${relative}\n${selected.map((line, index) => `${first + index}: ${line}`).join("\n")}\n${first + selected.length <= lines.length || Number(info.size) > bytesRead ? `[More content; next startLine: ${first + selected.length}. Reads cover the first 1 MiB.]` : "[End of file]"}`,
  );
}, Effect.scoped);

export function readThreadInspection(
  projection: OrchestrationV2ThreadProjection,
  beforeMessageId?: string,
  messageId?: string,
  startCharacter = 0,
) {
  if (messageId) {
    const message = projection.messages.find(
      (message) =>
        message.id === messageId &&
        !message.streaming &&
        ["user", "assistant"].includes(message.role),
    );
    if (!message) throw new Error("The requested message is unavailable.");
    const text = message.text.slice(startCharacter, startCharacter + 14000);
    return `${message.role} [${message.id}] from character ${startCharacter}:\n${text}\n${startCharacter + text.length < message.text.length ? `[More content; next startCharacter: ${startCharacter + text.length}]` : "[End of message]"}`;
  }
  const before = beforeMessageId
    ? projection.messages.findIndex((message) => message.id === beforeMessageId)
    : projection.messages.length;
  if (before < 0) throw new Error("The requested message is unavailable.");
  const messages = projection.messages
    .slice(0, before)
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !message.streaming &&
        message.text.trim(),
    );
  let remaining = 14000;
  const selected = [];
  for (const message of messages.toReversed().slice(0, 40)) {
    if (remaining <= 0) break;
    const text = message.text.slice(0, remaining);
    remaining -= text.length;
    selected.push(
      `${message.role} [${message.id}]${text.length < message.text.length ? " [shortened]" : ""}:\n${text}`,
    );
  }
  return bounded(
    `Thread: ${projection.thread.id}\nTitle: ${projection.thread.title}\nStatus: ${projection.runs.at(-1)?.status ?? "idle"}\nBranch: ${projection.thread.branch ?? "none"}\nWorktree: ${projection.thread.worktreePath ?? "project root"}\n\n${selected.toReversed().join("\n\n")}\n${selected.length < messages.length ? "[Earlier messages available; pass the first shown message ID as beforeMessageId.]" : "[Start of conversation]"}`,
  );
}

export const executeOrchestratorInspection = Effect.fn("orchestrator.executeInspection")(function* (
  item: OrchestratorPendingInspection,
  services: {
    readThread: ThreadManagementService["Service"]["getThreadProjection"];
    projectRoot: (projectId: string) => Effect.Effect<string, InspectionError>;
    searchWeb: (item: OrchestratorPendingInspection) => Effect.Effect<string, InspectionError>;
  },
) {
  const request = item.request;
  if (request.kind === "readThread") {
    const projection = yield* services.readThread(ThreadId.make(request.threadId));
    if (projection.thread.projectId !== item.localProjectId)
      return yield* new InspectionError({
        reason: "The thread no longer belongs to this project.",
      });
    return yield* Effect.try({
      try: () =>
        readThreadInspection(
          projection,
          request.beforeMessageId,
          request.messageId,
          request.startCharacter,
        ),
      catch: () => new InspectionError({ reason: "The requested thread excerpt is unavailable." }),
    });
  }
  if (request.kind === "webSearch") return bounded(yield* services.searchWeb(item));
  if (!item.localProjectId)
    return yield* new InspectionError({ reason: "A project is required for file inspection." });
  const root = yield* services.projectRoot(item.localProjectId);
  return yield* readProjectInspection(root, request);
});
