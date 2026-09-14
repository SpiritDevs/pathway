import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { CompanyId } from "@spiritdevs/contracts/company";
import type { OrchestrationV2ThreadProjection } from "@spiritdevs/contracts";
import type { ConvexClientLike } from "./convexSyncTransport.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { OrchestratorRun, type OrchestratorDecision } from "@spiritdevs/contracts/aiOrchestrator";
import {
  decodeOrchestratorDecision,
  executeOrchestratorRun,
  orchestratorPrompt,
  makeOrchestratorBackend,
  OrchestratorError,
  collectOrchestratorResults,
  type OrchestratorBackend,
} from "./orchestrator.ts";
const job = Schema.decodeUnknownSync(OrchestratorRun)({
  id: "job",
  generation: 2,
  selection: {
    instanceId: "codex",
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  name: "Chief",
  persona: "Concise and warm",
  instructions: "Coordinate my projects",
  context: '{"messages":[{"text":"Hi"}]}',
});
const result: OrchestratorDecision = {
  message: "Hello!",
  actions: [],
  summary: "The user greeted Chief.",
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
function backend() {
  const completions: OrchestratorDecision[] = [];
  const failures: string[] = [];
  return {
    completions,
    failures,
    api: {
      pendingResults: Effect.succeed([]),
      collectResult: () => Effect.succeed(true),
      claim: Effect.succeed(job),
      renew: () => Effect.succeed(true),
      holdForAllowance: () => Effect.succeed(true),
      complete: (_job, value) =>
        Effect.sync(() => {
          completions.push(value);
          return true;
        }),
      fail: (_job, reason) =>
        Effect.sync(() => {
          failures.push(reason);
          return true;
        }),
    } satisfies OrchestratorBackend,
  };
}

describe("tool-free coordinator reasoning", () => {
  it.effect("accepts an explicit quiet background decision", () =>
    Effect.gen(function* () {
      const quiet = { ...result, message: "", attention: "none" };
      expect(yield* decodeOrchestratorDecision(encodeJson(quiet))).toEqual(quiet);
    }),
  );
  it("supplies live allowance authority so an old hold notice cannot masquerade as current state", () => {
    const prompt = orchestratorPrompt(
      { ...job, context: '{"messages":[{"text":"The quota window reset. Work is held."}]}' },
      undefined,
      {
        canStart: true,
        shouldInterrupt: false,
        detail: "Allowance is available.",
        budgets: [],
      },
    );
    expect(prompt).toContain('CURRENT assignment allowance: {"canStart":true');
    expect(prompt).toContain("supersedes historical hold notices");
  });
  it.effect(
    "holds a quota-limited decision without marking it failed or trying another model",
    () =>
      Effect.gen(function* () {
        const test = backend();
        const holds: string[] = [];
        const outcome = yield* executeOrchestratorRun(
          {
            ...test.api,
            holdForAllowance: (_job, detail) =>
              Effect.sync(() => {
                holds.push(detail);
                return true;
              }),
          },
          job,
          () =>
            Effect.fail(
              new OrchestratorError({ reason: "allowance:This account reached its allocation." }),
            ),
        );
        expect(outcome).toBe("held");
        expect(holds).toEqual(["This account reached its allocation."]);
        expect(test.failures).toEqual([]);
        expect(test.completions).toEqual([]);
      }),
  );
  it.effect("returns only the completed delegated run's final visible answer", () =>
    Effect.gen(function* () {
      const test = backend();
      const captured: Array<unknown> = [];
      const projection = {
        runs: [
          { id: "latest-run", status: "completed" },
          { id: "later-run", status: "completed" },
        ],
        messages: [
          { runId: "old-run", role: "assistant", streaming: false, text: "Old private output" },
          { runId: "latest-run", role: "user", streaming: false, text: "Read the file" },
          {
            runId: "latest-run",
            role: "assistant",
            streaming: false,
            text: "Title: Check. Word: lighthouse.",
          },
          { runId: "latest-run", role: "assistant", streaming: true, text: "Unfinished text" },
          { runId: "latest-run", role: "assistant", streaming: false, text: "   " },
          {
            runId: "later-run",
            role: "assistant",
            streaming: false,
            text: "Unrelated later answer",
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      yield* collectOrchestratorResults(
        {
          ...test.api,
          pendingResults: Effect.succeed([
            { workId: "work", threadId: "thread", runId: "latest-run" },
          ]),
          collectResult: (result) =>
            Effect.sync(() => {
              captured.push(result);
              return true;
            }),
        },
        () => Effect.succeed(projection),
      );
      expect(captured).toEqual([
        {
          workId: "work",
          threadId: "thread",
          runId: "latest-run",
          text: "Title: Check. Word: lighthouse.",
        },
      ]);
    }),
  );
  it.effect(
    "reads a delegated conversation while it is still running without collecting a final result",
    () =>
      Effect.gen(function* () {
        const captured: Array<{ text: string; readRequestId?: string }> = [];
        const projection = {
          runs: [{ id: "running", status: "running" }],
          messages: [
            { role: "user", streaming: false, text: "Check the status" },
            { role: "assistant", streaming: false, text: "Verified finding" },
            { role: "system", streaming: false, text: "Internal instructions" },
            { role: "assistant", streaming: true, text: "Unfinished output" },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        yield* collectOrchestratorResults(
          {
            ...backend().api,
            pendingResults: Effect.succeed([
              { workId: "work", threadId: "thread", readRequestId: "request" },
            ]),
            collectResult: (value) =>
              Effect.sync(() => {
                captured.push(value);
                return true;
              }),
          },
          () => Effect.succeed(projection),
        );
        expect(captured).toHaveLength(1);
        expect(captured[0]!.readRequestId).toBe("request");
        expect(captured[0]!.text).toContain("Thread status: running");
        expect(captured[0]!.text).toContain("Check the status");
        expect(captured[0]!.text).toContain("Verified finding");
        expect(captured[0]!.text).not.toContain("Internal instructions");
        expect(captured[0]!.text).not.toContain("Unfinished output");
      }),
  );
  it.effect("bounds delegated reads and favors the latest visible conversation", () =>
    Effect.gen(function* () {
      const captured: string[] = [];
      const projection = {
        runs: [],
        messages: Array.from({ length: 30 }, (_, index) => ({
          role: "assistant",
          streaming: false,
          text: index === 29 ? "Latest finding" : "x".repeat(3000),
        })),
      } as unknown as OrchestrationV2ThreadProjection;
      yield* collectOrchestratorResults(
        {
          ...backend().api,
          pendingResults: Effect.succeed([
            { workId: "work", threadId: "thread", readRequestId: "request" },
          ]),
          collectResult: (value) =>
            Effect.sync(() => {
              captured.push(value.text);
              return true;
            }),
        },
        () => Effect.succeed(projection),
      );
      expect(captured[0]!.length).toBeLessThanOrEqual(16000);
      expect(captured[0]).toContain("Latest finding");
    }),
  );
  it.effect("retries an absent final answer instead of acknowledging an empty result", () =>
    Effect.gen(function* () {
      const captured: Array<unknown> = [];
      const projection = {
        runs: [{ id: "run", status: "completed" }],
        messages: [{ runId: "run", role: "assistant", streaming: true, text: "Findings" }],
      } as unknown as OrchestrationV2ThreadProjection;
      const api = {
        ...backend().api,
        pendingResults: Effect.succeed([{ workId: "work", threadId: "thread" }]),
        collectResult: (result: unknown) =>
          Effect.sync(() => {
            captured.push(result);
            return true;
          }),
      };
      yield* collectOrchestratorResults(api, () => Effect.succeed(projection));
      expect(captured).toEqual([]);
      yield* collectOrchestratorResults(api, () =>
        Effect.succeed({
          ...projection,
          messages: projection.messages.map((message) => ({ ...message, streaming: false })),
        }),
      );
      expect(captured).toEqual([
        { workId: "work", threadId: "thread", runId: "run", text: "Findings" },
      ]);
    }),
  );
  it.effect("does not try another model when applying a decision is rejected", () =>
    Effect.gen(function* () {
      const test = backend();
      const retries: Array<boolean | undefined> = [];
      const api: OrchestratorBackend = {
        ...test.api,
        complete: () => Effect.fail(new OrchestratorError({ reason: "Permission changed" })),
        fail: (_job, _reason, retryModel) =>
          Effect.sync(() => {
            retries.push(retryModel);
            return true;
          }),
      };
      expect(
        yield* executeOrchestratorRun(api, job, () => Effect.succeed(result), Effect.never),
      ).toBe("failed");
      expect(retries).toEqual([false]);
      expect(test.completions).toEqual([]);
    }),
  );
  it.effect("uses the deployed job endpoints and sends the environment's provider inventory", () =>
    Effect.gen(function* () {
      const calls: Array<{ name: string; args: unknown }> = [];
      const client: ConvexClientLike = {
        setAuth: () => {},
        query: () => Promise.reject(new Error("Unexpected query")),
        mutation: ((reference: FunctionReference<"mutation">, args: unknown) => {
          const name = getFunctionName(reference);
          calls.push({ name, args });
          return Promise.resolve(name === "aiOrchestratorJobs:claim" ? job : true);
        }) as ConvexClientLike["mutation"],
      };
      const backend = yield* makeOrchestratorBackend({
        companyId: CompanyId.make("company"),
        convexUrl: "http://localhost:3000",
        client,
        tokens: { token: Effect.succeed("test-token"), invalidate: () => Effect.void },
        providers: Effect.succeed([{ instanceId: "codex", driver: "codex" }]),
      });
      expect(yield* backend.claim).toEqual(job);
      yield* backend.renew(job);
      yield* backend.complete(job, result);
      yield* backend.fail(job, "Retry");
      expect(calls.map((call) => call.name)).toEqual([
        "aiOrchestratorJobs:claim",
        "aiOrchestratorJobs:renew",
        "aiOrchestratorJobs:complete",
        "aiOrchestratorJobs:failRun",
      ]);
      expect(calls[0]?.args).toEqual({
        companyId: "company",
        providers: [{ instanceId: "codex", driver: "codex" }],
      });
    }),
  );
  it.effect("samples and publishes host headroom only after claiming actual reasoning work", () =>
    Effect.gen(function* () {
      let hasJob = false;
      let samples = 0;
      const published: unknown[] = [];
      const resources = {
        sampledAt: 123,
        cpuUtilization: 0.2,
        cpuCount: 8,
        availableMemoryBytes: 8,
        totalMemoryBytes: 16,
      };
      const client: ConvexClientLike = {
        setAuth: () => {},
        query: () => Promise.reject(new Error("Unexpected query")),
        mutation: ((reference: FunctionReference<"mutation">, args: unknown) => {
          if (getFunctionName(reference) === "aiOrchestratorJobs:claim")
            return Promise.resolve(hasJob ? job : null);
          published.push(args);
          return Promise.resolve(null);
        }) as ConvexClientLike["mutation"],
      };
      const service = yield* makeOrchestratorBackend({
        companyId: CompanyId.make("company"),
        convexUrl: "http://localhost:3000",
        client,
        tokens: { token: Effect.succeed("test-token"), invalidate: () => Effect.void },
        providers: Effect.succeed([]),
        resources: Effect.sync(() => {
          samples++;
          return resources;
        }),
      });
      expect(yield* service.claim).toBeNull();
      expect(samples).toBe(0);
      hasJob = true;
      expect(yield* service.claim).toMatchObject({ id: job.id, hostResources: resources });
      expect(samples).toBe(1);
      expect(published).toEqual([{ companyId: "company", resources }]);
    }),
  );
  it.effect("accepts a conversational reply and rejects shell actions", () =>
    Effect.gen(function* () {
      expect(yield* decodeOrchestratorDecision(encodeJson(result))).toEqual(result);
      const rejected = yield* Effect.exit(
        decodeOrchestratorDecision(
          encodeJson({ ...result, actions: [{ kind: "shell", command: "touch a-file" }] }),
        ),
      );
      expect(rejected._tag).toBe("Failure");
      expect(orchestratorPrompt(job)).toContain("no coding, filesystem, Git, shell");
    }),
  );
  it.effect("only publishes a decision after renewing its claim", () =>
    Effect.gen(function* () {
      const test = backend();
      expect(
        yield* executeOrchestratorRun(test.api, job, () => Effect.succeed(result), Effect.never),
      ).toBe("completed");
      expect(test.completions).toEqual([result]);
      const abandoned = backend();
      expect(
        yield* executeOrchestratorRun(
          { ...abandoned.api, renew: () => Effect.succeed(false) },
          job,
          () => Effect.succeed(result),
          Effect.never,
        ),
      ).toBe("abandoned");
      expect(abandoned.completions).toEqual([]);
    }),
  );
  it.effect("interrupts reasoning when renewal loses its generation", () =>
    Effect.gen(function* () {
      const test = backend();
      const started = yield* Deferred.make<void>();
      const renew = yield* Deferred.make<void>();
      let attempts = 0;
      const fiber = yield* executeOrchestratorRun(
        { ...test.api, renew: () => Effect.sync(() => ++attempts === 1) },
        job,
        () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        Deferred.await(renew),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(renew, undefined);
      expect(yield* Fiber.join(fiber)).toBe("abandoned");
      expect(test.completions).toEqual([]);
      expect(test.failures).toEqual([]);
    }),
  );
});

it.effect("requests only the authorized prefix and rejects ignored or oversized ranges", () =>
  Effect.gen(function* () {
    let status = 206;
    let body = "abc";
    const client: ConvexClientLike = {
      setAuth: () => {},
      query: (() =>
        Promise.resolve("https://attachments.example.test/file")) as ConvexClientLike["query"],
      mutation: () => Promise.reject(new Error("Unexpected mutation")),
    };
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.headers.authorization).toBe("Bearer test-token");
        expect(request.headers.range).toBe("bytes=0-2");
        return HttpClientResponse.fromWeb(request, new Response(body, { status }));
      }),
    );
    const service = yield* makeOrchestratorBackend({
      companyId: CompanyId.make("company"),
      convexUrl: "https://cloud.example.test",
      client,
      tokens: { token: Effect.succeed("test-token"), invalidate: () => Effect.void },
      providers: Effect.succeed([]),
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    const input = {
      ...job,
      attachments: [
        {
          id: "text",
          type: "file" as const,
          name: "large.txt",
          mimeType: "text/plain",
          sizeBytes: 50 * 1024 * 1024,
        },
      ],
    };
    expect(new TextDecoder().decode(yield* service.readAttachment(input, "text", 3))).toBe("abc");
    status = 200;
    expect((yield* service.readAttachment(input, "text", 3).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    status = 206;
    body = "abcd";
    expect((yield* service.readAttachment(input, "text", 3).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    body = "ab";
    expect((yield* service.readAttachment(input, "text", 3).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
  }),
);
