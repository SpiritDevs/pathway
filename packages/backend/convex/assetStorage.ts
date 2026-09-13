"use node";
// @effect-diagnostics cryptoRandomUUID:off -- Unique server-side multipart boundary.
// @effect-diagnostics globalFetch:off -- Convex Node action streams storage bytes.
import * as NodeCrypto from "node:crypto";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel.js";
import { v } from "convex/values";
import { internalAction } from "./_generated/server.js";
import { storageRequest, signedStorageUrl, previewable } from "./lib/assetStorageClient.ts";
export const prepare = internalAction({
  args: { fileName: v.string(), mimeType: v.string(), byteSize: v.number(), customId: v.string() },
  handler: async (_ctx, args) => {
    const result = await storageRequest("/v7/prepareUpload", {
      fileName: args.fileName,
      fileSize: args.byteSize,
      fileType: args.mimeType,
      customId: args.customId,
      contentDisposition: "attachment",
      acl: "private",
      expiresIn: 600,
    });
    if (typeof result.key !== "string" || typeof result.url !== "string")
      throw new Error("Private upload preparation did not return a key and URL.");
    return { key: result.key, url: result.url };
  },
});
export const verify = internalAction({
  args: { key: v.string(), maxBytes: v.number() },
  handler: async (_ctx, args) => {
    const url = await signedStorageUrl(args.key);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error("Original upload is not complete.");
    const hash = NodeCrypto.createHash("sha256"),
      reader = response.body.getReader();
    let byteSize = 0;
    let header = new Uint8Array();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        byteSize += value.byteLength;
        if (byteSize > args.maxBytes) throw new Error("Uploaded original exceeds its reservation.");
        hash.update(value);
        if (header.length < 128) {
          const next = new Uint8Array(Math.min(128, header.length + value.length));
          next.set(header);
          next.set(value.slice(0, next.length - header.length), header.length);
          header = next;
        }
      }
    } finally {
      await reader.cancel();
    }
    return { byteSize, checksum: hash.digest("hex"), previewReady: previewable(header) };
  },
});
export const deleteObjects = internalAction({
  args: { keys: v.array(v.string()) },
  handler: async (_ctx, args) => {
    if (!args.keys.length) return;
    const r = await storageRequest("/v6/deleteFiles", { fileKeys: args.keys });
    if (r.success !== true) throw new Error("Storage deletion was not confirmed.");
  },
});

export const cleanup = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(
      makeFunctionReference<
        "query",
        Record<string, never>,
        { id: Id<"assets">; key: string | null }[]
      >("assets:cleanupCandidates"),
      {},
    );
    for (const r of rows) {
      if (
        !(await ctx.runMutation(
          makeFunctionReference<"mutation", { id: Id<"assets"> }, boolean>("assets:claimCleanup"),
          { id: r.id },
        ))
      )
        continue;
      const keys = await ctx.runQuery(
        makeFunctionReference<"query", { id: Id<"assets"> }, string[]>("assets:cleanupKeys"),
        { id: r.id },
      );
      if (keys.length) {
        const result = await storageRequest("/v6/deleteFiles", { fileKeys: keys });
        if (result.success !== true) throw new Error("Storage deletion not confirmed.");
      }
      await ctx.runMutation(
        makeFunctionReference<"mutation", { id: Id<"assets"> }, null>("assets:finishCleanup"),
        { id: r.id },
      );
    }
  },
});
export const cleanupRepresentations = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        Record<string, never>,
        { id: Id<"assetRepresentations">; key: string | null }[]
      >("assets:claimStaleRepresentations"),
      {},
    );
    for (const r of rows) {
      if (r.key) {
        const result = await storageRequest("/v6/deleteFiles", { fileKeys: [r.key] });
        if (result.success !== true) throw new Error("Representation cleanup not confirmed.");
      }
      await ctx.runMutation(
        makeFunctionReference<"mutation", { id: Id<"assetRepresentations"> }, null>(
          "assets:finishRepresentationCleanup",
        ),
        { id: r.id },
      );
    }
  },
});
/** Server-to-server migration copies streams; no client can nominate an arbitrary URL. */
export const copyLegacy = internalAction({
  args: {
    sourceUrl: v.string(),
    uploadUrl: v.string(),
    key: v.string(),
    fileName: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
  },
  handler: async (ctx, args) => {
    const source = await fetch(args.sourceUrl);
    if (!source.ok || !source.body) throw new Error("Legacy original could not be read.");
    const boundary = `pathway-${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    const safeName = args.fileName.replace(/[\r\n"\\]/g, "_");
    const prefix = encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    const reader = source.body.getReader();
    const hash = NodeCrypto.createHash("sha256");
    let byteSize = 0,
      started = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(prefix);
          return;
        }
        try {
          const next = await reader.read();
          if (next.done) {
            if (byteSize !== args.byteSize) throw new Error("Legacy original size changed.");
            controller.enqueue(suffix);
            controller.close();
            return;
          }
          byteSize += next.value.byteLength;
          if (byteSize > args.byteSize) throw new Error("Legacy original exceeds reserved size.");
          hash.update(next.value);
          controller.enqueue(next.value);
        } catch (error) {
          await reader.cancel();
          controller.error(error);
        }
      },
      async cancel() {
        await reader.cancel();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(prefix.byteLength + args.byteSize + suffix.byteLength),
        Range: "bytes=0-",
        "x-uploadthing-version": "7.7.4",
      },
      body,
      duplex: "half",
    };
    const uploaded = await fetch(args.uploadUrl, init);
    if (!uploaded.ok) throw new Error("Private migration upload failed.");
    const checksum = hash.digest("hex");
    const verified = await ctx.runAction(
      makeFunctionReference<
        "action",
        { key: string; maxBytes: number },
        { byteSize: number; checksum: string; previewReady: boolean }
      >("assetStorage:verify"),
      { key: args.key, maxBytes: args.byteSize },
    );
    if (verified.byteSize !== byteSize || verified.checksum !== checksum)
      throw new Error("Private migration verification failed.");
    return verified;
  },
});
