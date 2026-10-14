import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

import * as CloudSync from "./cloudSync.ts";
import * as Contracts from "./index.ts";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "./index.ts";
import { CloudAgentThreadShell } from "./cloudProject.ts";
import { CompanyId } from "./company.ts";
import { OrchestrationV2ShellSnapshotJson } from "./orchestrationV2.ts";

/** Paths on a codec's encoded side that still hold a non-JSON value such as `DateTime.Utc`. */
function nonJsonPaths(ast: SchemaAST.AST, path: string): ReadonlyArray<string> {
  switch (ast._tag) {
    case "Declaration":
      return [`${path} (${String(ast.annotations?.expected ?? "declaration")})`];
    case "Objects":
      return [
        ...ast.propertySignatures.flatMap((property) =>
          nonJsonPaths(property.type, `${path}.${String(property.name)}`),
        ),
        ...ast.indexSignatures.flatMap((index) => nonJsonPaths(index.type, `${path}[key]`)),
      ];
    case "Arrays":
      return [...ast.elements, ...ast.rest].flatMap((element) =>
        nonJsonPaths(element, `${path}[]`),
      );
    case "Union":
      return ast.types.flatMap((member) => nonJsonPaths(member, path));
    // Recursive schemas (the computer accessibility tree) are not walked.
    default:
      return [];
  }
}

// Every `*Json` codec is persisted or replicated after `JSON.stringify`, as are the cloud sync
// payloads, so a `DateTime.Utc` left unmapped writes fine and then never decodes again.
const persistedCodecs = Object.entries({ ...Contracts, ...CloudSync }).flatMap(
  ([name, value]: [string, unknown]) =>
    /Json$|^Sync\w*Payload$|^CloudAgentThreadShell$/.test(name) && Schema.isSchema(value)
      ? [{ name, ast: value.ast }]
      : [],
);

type Populated<T> = { readonly [K in keyof T]-?: Exclude<T[K], null | undefined> };

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-populated");
const instanceId = ProviderInstanceId.make("codex");

/** Every optional and nullable shell field set, so no date can hide behind an absent value. */
const populatedThreadShell: Populated<OrchestrationV2ThreadShell> = {
  subagentComposerStates: [
    {
      childThreadId: ThreadId.make("thread-child"),
      origin: "app_owned",
      driver: ProviderDriverKind.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "effort", value: "high" }],
    },
  ],
  allowanceHold: "hold-1",
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project-populated"),
  conversationCompanyId: CompanyId.make("company-1"),
  orchestratorOrigin: {
    execution: { threadId: "thread-orchestrator", runId: "run-orchestrator", messageId: "m-1" },
    orchestratorId: "orchestrator-1",
    companyId: "company-1",
    commandId: "command-orchestrator",
  },
  conversationPath: "/conversations/populated",
  ownedWorktreePath: "/worktrees/populated",
  ownedBranch: "populated",
  temporary: true,
  keptAt: now,
  title: "Populated",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.4" },
  usedModels: [{ instanceId, model: "gpt-5.4" }],
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "populated",
  worktreePath: "/worktrees/populated",
  workspaceMove: {
    id: CommandId.make("command-move"),
    status: "completed",
    phase: "queued",
    sourceCwd: "/workspace",
    sourceHead: "abc123",
    fileCount: 1,
    terminalCount: 0,
    transferStashOid: "def456",
    targetWorktreePath: "/worktrees/populated",
    targetBranch: "populated",
    setup: "no_script",
    detail: "done",
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  },
  lineage: {
    rootThreadId: threadId,
    parentThreadId: ThreadId.make("thread-parent"),
    relationshipToParent: "fork",
    parentEnvironmentId: EnvironmentId.make("environment-parent"),
  },
  forkKind: "side_chat",
  locations: ["agents", "issues"],
  forkedFrom: { type: "run", threadId: ThreadId.make("thread-parent"), runId: RunId.make("run-0") },
  activeProviderThreadId: ProviderThreadId.make("provider-thread-1"),
  latestRunId: RunId.make("run-1"),
  latestRunRequestedAt: now,
  latestRunStartedAt: now,
  latestRunCompletedAt: now,
  activeRunId: RunId.make("run-1"),
  activityRunStatus: "running",
  status: "running",
  lastError: "boom",
  pendingRuntimeRequest: {
    isBlocking: true,
    id: RuntimeRequestId.make("runtime-request-1"),
    kind: "command",
    createdAt: now,
  },
  latestVisibleMessage: {
    id: MessageId.make("message-1"),
    role: "assistant",
    text: "Done",
    updatedAt: now,
  },
  latestUserMessageAt: now,
  detachedPullRequestUrls: ["https://example.com/pr/1"],
  attachedPullRequests: [{ number: 2, url: "https://example.com/pr/2" }],
  attachedPullRequest: { number: 2, url: "https://example.com/pr/2" },
  hasActionableProposedPlan: true,
  pendingBackgroundTasks: [{ taskId: "task-1", description: "Build", taskType: "bash" }],
  itemCount: 3,
  visibleItemCount: 2,
  createdAt: now,
  updatedAt: now,
  archivedAt: now,
  settledOverride: "settled",
  settledAt: now,
  settleAfterCompletion: true,
  snoozedUntil: now,
  snoozedAt: now,
  pinnedAt: now,
  pinOrderKey: "a0",
  lastVisitedAt: now,
  titleRegeneration: { requestId: CommandId.make("command-title"), startedAt: now },
  deletedAt: now,
};

function jsonRoundTrip<S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]) {
  const encoded = JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value)));
  return Schema.decodeUnknownSync(schema)(encoded);
}

describe("persisted JSON codecs", () => {
  it("encode every field to JSON-safe values", () => {
    expect(persistedCodecs.length).toBeGreaterThan(0);
    expect(
      persistedCodecs.flatMap(({ name, ast }) => nonJsonPaths(SchemaAST.toEncoded(ast), name)),
    ).toEqual([]);
  });

  it("round-trips a fully populated shell snapshot through JSON", () => {
    const snapshot = {
      schemaVersion: 1,
      snapshotSequence: 7,
      threads: [populatedThreadShell],
      archivedThreads: [populatedThreadShell],
      projects: [],
    };

    expect(jsonRoundTrip(OrchestrationV2ShellSnapshotJson, snapshot)).toEqual(snapshot);
  });

  it("round-trips a fully populated cloud thread shell through JSON", () => {
    const { text: _text, ...latestVisibleMessage } = populatedThreadShell.latestVisibleMessage;
    const shell = { ...populatedThreadShell, latestVisibleMessage };

    expect(jsonRoundTrip(CloudAgentThreadShell, shell)).toEqual(shell);
  });
});
