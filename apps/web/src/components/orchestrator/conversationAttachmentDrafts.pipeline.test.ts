// @effect-diagnostics nodeBuiltinImport:off -- Synthetic fixture input; no browser or private data.
import * as NodeFSP from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { installImageCodecs } from "../../lib/test/imageCodecs";
import {
  useConversationAttachmentDrafts,
  type ConversationAttachmentDraft,
} from "./conversationAttachmentDrafts";

const changes = vi.hoisted(() => ({ notify: () => {} }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useEffect: () => {},
    useState: <T>(initial: T) => {
      const [value, set] = reactHookHarness.useState(initial);
      return [
        value,
        (next: T) => {
          set(next);
          changes.notify();
        },
      ];
    },
  };
});
let cleanup: () => Promise<void>;
beforeAll(() => {
  cleanup = installImageCodecs();
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  hooks.reset();
  changes.notify = () => {};
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(failFinalizeOnce = false) {
  const discarded = deferred<void>();
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const uploads: Array<{ file: Blob; mime: string }> = [];
  vi.stubGlobal(
    "XMLHttpRequest",
    class extends EventTarget {
      upload = new EventTarget();
      status = 200;
      responseText = JSON.stringify({ storageId: "stored-image" });
      mime = "";
      open() {}
      setRequestHeader(_name: string, value: string) {
        this.mime = value;
      }
      send(file: Blob) {
        uploads.push({ file, mime: this.mime });
        this.dispatchEvent(new Event("load"));
      }
    },
  );
  const client = {
    mutation: async (ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) => {
      const path = getFunctionName(ref);
      calls.push({ path, args });
      if (path.endsWith(":finalize") && failFinalizeOnce) {
        failFinalizeOnce = false;
        throw new Error("Connection lost during finalize");
      }
      if (path.endsWith(":discard")) discarded.resolve();
      return path.endsWith(":prepare")
        ? { ready: false, uploadUrl: "https://storage.example/upload" }
        : null;
    },
  } as unknown as ConvexClient;
  const render = () => {
    hooks.beginRender();
    return useConversationAttachmentDrafts(client, "test-account");
  };
  const settled = deferred<ConversationAttachmentDraft>();
  changes.notify = () => {
    const row = render().drafts.chat?.[0];
    if (row?.status === "ready" || row?.status === "failed") settled.resolve(row);
  };
  return { render, calls, uploads, settled: settled.promise, discarded: discarded.promise };
}

it("uploads converted HEIC bytes and previews the same file with matching metadata", async () => {
  const test = harness();
  const original = new File(
    [
      new Uint8Array(
        await NodeFSP.readFile(new URL("../../lib/fixtures/heic/two-colors.heic", import.meta.url)),
      ),
    ],
    "photo.HEIC",
    { type: "image/heic" },
  );
  test.render().add("chat", "target", [original]);
  expect(test.render().drafts.chat?.[0]?.status).toBe("preparing");
  expect(test.calls).toHaveLength(0);
  const row = await test.settled;
  expect(row.status).toBe("ready");
  expect(row.attachment).toMatchObject({
    name: "photo.webp",
    mimeType: "image/webp",
    sizeBytes: row.file.size,
  });
  expect(test.calls[0]).toEqual({
    path: "aiOrchestratorAttachments:prepare",
    args: { chatId: "chat", targetId: "target", attachment: row.attachment },
  });
  expect(test.uploads).toEqual([{ file: row.file, mime: row.file.type }]);
  const preview = await (await fetch(row.previewUrl!)).arrayBuffer();
  expect(preview).toEqual(await test.uploads[0]!.file.arrayBuffer());
  expect(Buffer.from(preview).subarray(8, 12).toString()).toBe("WEBP");
  expect(test.calls[1]?.path).toBe("aiOrchestratorAttachments:finalize");
  test.render().sent("chat", [row.attachment.id]);
});

it("retains a visible conversion failure and never prepares or uploads invalid HEIC", async () => {
  const test = harness();
  test
    .render()
    .add("chat", "target", [new File(["invalid"], "broken.heic", { type: "image/heic" })]);
  const row = await test.settled;
  expect(row.status).toBe("failed");
  expect(row.error).toContain("could not be converted");
  expect(row.previewUrl).toBeUndefined();
  expect(test.calls).toEqual([]);
  expect(test.uploads).toEqual([]);
});

it("removing a preparing attachment prevents upload and preview creation", async () => {
  const test = harness();
  const release = deferred<ArrayBuffer>();
  const headerRead = deferred<void>();
  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  vi.spyOn(file, "slice").mockReturnValue({
    arrayBuffer: () => {
      headerRead.resolve();
      return release.promise;
    },
  } as Blob);
  test.render().add("chat", "target", [file]);
  await headerRead.promise;
  const id = test.render().drafts.chat![0]!.attachment.id;
  test.render().remove("chat", id);
  release.resolve(new ArrayBuffer(0));
  await test.discarded;
  expect(test.render().drafts.chat).toEqual([]);
  expect(test.uploads).toEqual([]);
  expect(test.calls.map((call) => call.path)).toEqual(["aiOrchestratorAttachments:discard"]);
});

it("retries finalization with the same converted bytes, metadata and preview", async () => {
  const test = harness(true);
  const original = new File(
    [
      new Uint8Array(
        await NodeFSP.readFile(new URL("../../lib/fixtures/heic/two-colors.heic", import.meta.url)),
      ),
    ],
    "photo.heic",
    { type: "image/heic" },
  );
  test.render().add("chat", "target", [original]);
  const failed = await test.settled;
  expect(failed.status).toBe("failed");
  expect(failed.storageId).toBe("stored-image");
  const ready = deferred<ConversationAttachmentDraft>();
  changes.notify = () => {
    const row = test.render().drafts.chat?.[0];
    if (row?.status === "ready") ready.resolve(row);
  };
  test.render().retry("chat", "target", failed.attachment.id);
  const retried = await ready.promise;
  expect(retried.file).toBe(failed.file);
  expect(retried.previewUrl).toBe(failed.previewUrl);
  expect(test.uploads).toHaveLength(1);
  expect(
    test.calls.filter((call) => call.path.endsWith(":prepare")).map((call) => call.args.attachment),
  ).toEqual([failed.attachment, failed.attachment]);
  test.render().sent("chat", [retried.attachment.id]);
});
