import { describe, expect, it, vi } from "vite-plus/test";
import {
  MarkdownHighlightQueue,
  markdownHighlightKey,
  type HighlightResponse,
} from "./markdownHighlightQueue";

function harness() {
  const listeners = new Map<string, (event: MessageEvent<HighlightResponse>) => void>();
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: (
      type: string,
      listener: (event: MessageEvent<HighlightResponse>) => void,
    ) => {
      listeners.set(type, listener);
    },
  };
  const factory = vi.fn(() => worker as unknown as Worker);
  const queue = new MarkdownHighlightQueue(factory);
  const reply = (html: string | null) => {
    const request = worker.postMessage.mock.lastCall![0];
    listeners.get("message")!({
      data: { id: request.id, html },
    } as MessageEvent<HighlightResponse>);
  };
  const fail = () => listeners.get("error")!({} as MessageEvent<HighlightResponse>);
  return { queue, worker, factory, reply, fail };
}

describe("markdown highlight queue", () => {
  it("starts lazily, deduplicates requests and caches HTML by code, language and theme", async () => {
    const { queue, worker, factory, reply } = harness();
    expect(factory).not.toHaveBeenCalled();
    const first = queue.request("const x = 1", "ts", "pierre-dark");
    const duplicate = queue.request("const x = 1", "ts", "pierre-dark");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    reply("<pre>highlighted</pre>");
    await expect(first.result).resolves.toBe("<pre>highlighted</pre>");
    await expect(duplicate.result).resolves.toBe("<pre>highlighted</pre>");
    await expect(queue.request("const x = 1", "ts", "pierre-dark").result).resolves.toBe(
      "<pre>highlighted</pre>",
    );
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(queue.get(markdownHighlightKey("const x = 1", "ts", "pierre-light"))).toBeNull();
    expect(queue.get(markdownHighlightKey("const x = 1", "text", "pierre-dark"))).toBeNull();
  });

  it("bounds outstanding work and drops queued blocks on unmount without canceling other consumers", async () => {
    const { queue, worker, reply } = harness();
    const requests = Array.from({ length: 32 }, (_, i) =>
      queue.request(`block ${i}`, "ts", "pierre-dark"),
    );
    await expect(queue.request("overflow", "ts", "pierre-dark").result).resolves.toBeNull();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    requests[1]!.cancel();
    await expect(requests[1]!.result).resolves.toBeNull();
    const duplicate = queue.request("block 0", "ts", "pierre-dark");
    requests[0]!.cancel();
    reply("first");
    await expect(duplicate.result).resolves.toBe("first");
    expect(worker.postMessage.mock.lastCall![0].code).toBe("block 2");
    expect(worker.terminate).not.toHaveBeenCalled();
    queue.request("fits now", "ts", "pierre-dark");
  });

  it("leaves oversized blocks and failed workers as plain code without blocking the main thread", async () => {
    const { queue, worker, factory, fail } = harness();
    await expect(
      queue.request("x".repeat(2 * 1024 * 1024 + 1), "text", "pierre-dark").result,
    ).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
    const active = queue.request("a", "ts", "pierre-dark");
    const queued = queue.request("b", "ts", "pierre-dark");
    fail();
    await expect(active.result).resolves.toBeNull();
    await expect(queued.result).resolves.toBeNull();
    await expect(queue.request("c", "ts", "pierre-dark").result).resolves.toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("continues after a block cannot be highlighted and enforces the aggregate byte limit", async () => {
    const { queue, worker, reply } = harness();
    const active = queue.request("a".repeat(1024 * 1024), "ts", "pierre-dark");
    const queued = queue.request("b".repeat(1024 * 1024), "ts", "pierre-dark");
    await expect(queue.request("over byte limit", "ts", "pierre-dark").result).resolves.toBeNull();
    reply(null);
    await expect(active.result).resolves.toBeNull();
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    reply("highlighted");
    await expect(queued.result).resolves.toBe("highlighted");
    expect(
      queue.get(markdownHighlightKey("a".repeat(1024 * 1024), "ts", "pierre-dark")),
    ).toBeNull();
  });

  it("settles requests when worker creation fails", async () => {
    const queue = new MarkdownHighlightQueue(() => {
      throw new Error("Workers unavailable");
    });
    await expect(queue.request("a", "ts", "pierre-dark").result).resolves.toBeNull();
    await expect(queue.request("b", "ts", "pierre-dark").result).resolves.toBeNull();
  });
});
