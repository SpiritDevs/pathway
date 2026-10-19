// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { parseThreadSegmentFromAttachmentId } from "../attachmentStore.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  deletePendingAttachment,
  issueAttachmentUploadUrl,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./AttachmentUpload.ts";

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "pathway-attachment-upload-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const uploadInput = {
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
} as const;

describe("AttachmentUpload", () => {
  it.effect("signs metadata and rejects tampered or expired upload tokens", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      expect(parseThreadSegmentFromAttachmentId(issued.attachmentId)).toBe("pending");
      expect(issued.attachmentId).toMatch(/-pdf$/);

      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      expect(yield* validateAttachmentUploadToken(token)).toMatchObject({
        type: "file",
        attachmentId: issued.attachmentId,
        name: "report.pdf",
        sizeBytes: 6,
      });
      const [payload, signature] = token.split(".");
      expect(yield* validateAttachmentUploadToken(`${payload}x.${signature}`)).toBeNull();

      yield* TestClock.adjust("11 minutes");
      expect(yield* validateAttachmentUploadToken(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("streams exact bytes and deletes only the pending source", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) throw new Error("Expected valid upload claims.");

      expect(
        yield* storeAttachmentUpload(
          claims,
          Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
        ),
      ).toEqual({ ok: true });
      const pendingPath = NodePath.join(config.attachmentsDir, `${issued.attachmentId}.pdf`);
      expect(NodeFS.readFileSync(pendingPath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));

      const claimedPath = NodePath.join(
        config.attachmentsDir,
        issued.attachmentId.replace(/^pending-/, "thread-1-") + ".pdf",
      );
      NodeFS.copyFileSync(pendingPath, claimedPath);
      yield* deletePendingAttachment(issued.attachmentId);
      yield* deletePendingAttachment(issued.attachmentId);
      yield* deletePendingAttachment(issued.attachmentId.replace(/^pending-/, "thread-1-"));
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(claimedPath)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes partial streamed uploads with the wrong byte count", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) throw new Error("Expected valid upload claims.");

      expect(yield* storeAttachmentUpload(claims, Stream.make(new Uint8Array(7)))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sweeps stale pending uploads while issuing a new URL", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const staleId = "pending-00000000-0000-4000-8000-0000000000cc-pdf";
      const stalePath = NodePath.join(config.attachmentsDir, `${staleId}.pdf`);
      NodeFS.writeFileSync(stalePath, Buffer.from("stale"));
      NodeFS.utimesSync(stalePath, 0, 0);

      yield* TestClock.adjust("25 hours");
      yield* issueAttachmentUploadUrl(uploadInput);
      expect(NodeFS.existsSync(stalePath)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});
