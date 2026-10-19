import * as NodeCrypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeUploadThingRestClient } from "../convex/issueAttachments.ts";

afterEach(() => {
  delete process.env.UPLOADTHING_TOKEN;
});

describe("UploadThing REST client", () => {
  it("prepares, verifies bytes, and deletes through the injectable fetch seam", async () => {
    process.env.UPLOADTHING_TOKEN = "test-token";
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v7/prepareUpload"))
        return Response.json({ key: "file-key", url: "https://ingest.test/file-key" });
      if (url.endsWith("/v6/deleteFiles")) return Response.json({ success: true, deletedCount: 1 });
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    const client = makeUploadThingRestClient(fetcher);

    await expect(
      client.prepareUpload({
        fileName: "proof.png",
        mimeType: "image/png",
        byteSize: bytes.byteLength,
        customId: "attachment-1",
      }),
    ).resolves.toMatchObject({ key: "file-key", url: "https://ingest.test/file-key" });
    await expect(client.verifyUpload("file-key")).resolves.toMatchObject({
      key: "file-key",
      byteSize: bytes.byteLength,
      mimeType: "image/png",
      checksum: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    });
    await client.deleteFiles(["file-key"]);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "x-uploadthing-api-key": "test-token" }),
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      fileName: "proof.png",
      fileSize: bytes.byteLength,
      fileType: "image/png",
      customId: "attachment-1",
      acl: "public-read",
    });
  });
});
