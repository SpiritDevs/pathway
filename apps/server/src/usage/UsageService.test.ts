import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ProviderInstanceId, UsageDay } from "@spiritdevs/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make } from "./UsageService.ts";

const encodeTranscript = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("reports partial scans on cold and warm reads and includes archived usage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usage-service-" });
      const claude = `${root}/claude/projects/project`;
      const archive = `${root}/codex/archived_sessions`;
      yield* fs.makeDirectory(claude, { recursive: true });
      yield* fs.makeDirectory(archive, { recursive: true });
      yield* fs.writeFileString(
        `${claude}/valid.jsonl`,
        encodeTranscript({
          type: "assistant",
          timestamp: "2026-09-05T00:00:00Z",
          sessionId: "claude-session",
          message: {
            id: "msg",
            model: "claude-fable-5",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
      );
      yield* fs.writeFileString(`${claude}/broken.jsonl`, '{"type":"assistant","usage":');
      yield* fs.writeFileString(
        `${archive}/archived.jsonl`,
        [
          { type: "session_meta", payload: { id: "codex-session" } },
          { type: "turn_context", payload: { model: "gpt-5" } },
          {
            type: "event_msg",
            timestamp: "2026-09-05T01:00:00Z",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 20, output_tokens: 5 },
                total_token_usage: { input_tokens: 20, output_tokens: 5 },
              },
            },
          },
        ]
          .map((line) => encodeTranscript(line))
          .join("\n"),
      );
      yield* fs.writeFileString(
        `${claude}/invalid-shape.jsonl`,
        encodeTranscript({
          type: "assistant",
          timestamp: "invalid",
          message: { model: "claude-fable-5", usage: { input_tokens: 10, output_tokens: 5 } },
        }),
      );
      const service = yield* make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(root, root),
            ServerSettingsService.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: "claudeAgent",
                  config: { homePath: `${root}/claude` },
                },
                [ProviderInstanceId.make("codex")]: {
                  driver: "codex",
                  config: { homePath: `${root}/codex` },
                },
              },
            }),
          ),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}"))),
          ),
        ),
      );
      const input = {
        sinceDay: UsageDay.make("2026-09-05"),
        untilDay: UsageDay.make("2026-09-05"),
        timeZone: "UTC",
      };
      for (let scan = 0; scan < 2; scan += 1) {
        const result = yield* service.readSummary(input);
        expect(result.buckets).toHaveLength(2);
        expect(result.buckets.every((bucket) => Boolean(bucket.sourceId))).toBe(true);
        expect(
          result.sources.find((source) => source.fingerprint.provider === "claude"),
        ).toMatchObject({ status: "partial", malformedRecords: 2, scannedFiles: 1 });
        expect(result.projects.every((project) => project.provider === "claude")).toBe(true);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
