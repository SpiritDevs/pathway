import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import type { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { uploadAsset } from "./assetClient";
describe("durable asset upload", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("finalizes only after storage accepted the original", async () => {
    const calls: string[] = [];
    const action = vi.fn(async (ref: FunctionReference<"action">, _args: unknown) => {
      const name = getFunctionName(ref);
      calls.push(name);
      return name.endsWith("prepareUpload")
        ? { assetId: "asset", uploadUrl: "https://upload.example/file", state: "upload-required" }
        : { id: "asset", originalReady: true };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        expect((options.headers as Record<string, string>).Range).toBe("bytes=0-");
        calls.push("bytes");
        return { ok: true };
      }),
    );
    await uploadAsset(
      { action } as unknown as ConvexClient,
      {
        companyId: "company",
        file: new File(["hello"], "report.txt", { type: "text/plain" }),
        clientRequestId: "retry-key",
      },
      vi.fn(),
    );
    expect(calls).toEqual(["assets:prepareUpload", "bytes", "assets:finalizeUpload"]);
    expect(action.mock.calls[0]?.[1]).toMatchObject({
      clientRequestId: "retry-key",
      fileName: "report.txt",
      byteSize: 5,
    });
  });
  it("does not finalize failed uploads or report them as ready", async () => {
    const action = vi.fn(async () => ({
      assetId: "asset",
      uploadUrl: "https://upload.example/file",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    await expect(
      uploadAsset(
        { action } as unknown as ConvexClient,
        {
          companyId: "company",
          file: new File(["bytes"], "review.mp4"),
          clientRequestId: "same-on-retry",
        },
        vi.fn(),
      ),
    ).rejects.toThrow("still available to retry");
    expect(action).toHaveBeenCalledTimes(1);
  });
});
