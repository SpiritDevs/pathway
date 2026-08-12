// @effect-diagnostics nodeBuiltinImport:off
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_EMAIL_CAPTURE_SETTINGS,
  EmailMailSlug,
  ProjectId,
  type EmailCaptureReceipt,
  type EmailProjectSettings,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import nodemailer from "nodemailer";

import * as ServerSettings from "../serverSettings.ts";
import { EmailCaptureService, layer as emailCaptureLayer } from "./EmailCaptureService.ts";
import * as EmailProjectCatalog from "./EmailProjectCatalog.ts";
import { EmailStore, layerAtPath as emailStoreLayerAtPath } from "./EmailStore.ts";
import { layerAtPath as emailWaitStoreLayerAtPath } from "./EmailWaitStore.ts";

const alphaProjectId = ProjectId.make("project-alpha");
const betaProjectId = ProjectId.make("project-beta");

const projectSettings = (
  projectId: typeof alphaProjectId,
  mailSlug: "alpha" | "beta",
): EmailProjectSettings => ({
  projectId,
  mailSlug: EmailMailSlug.make(mailSlug),
  retention: { maxMessages: null, maxAgeDays: null },
  toastMuted: false,
  twoFactorCodeRegex: null,
});

const projects = [
  { projectId: alphaProjectId, title: "Alpha", workspaceRoot: "/work/alpha" },
  { projectId: betaProjectId, title: "Beta", workspaceRoot: "/work/beta" },
] as const;

const freePort = Effect.acquireUseRelease(
  Effect.callback<ReturnType<typeof createServer>, Error>((resume) => {
    const server = createServer();
    server.once("error", (cause) => resume(Effect.fail(cause)));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) => {
    const address = server.address();
    if (address === null || typeof address === "string") return Effect.die("Expected TCP port");
    return Effect.succeed(address.port);
  },
  (server) => Effect.callback<void>((resume) => server.close(() => resume(Effect.void))),
);

const layerFor = (databasePath: string, port: number) => {
  const dependencies = Layer.mergeAll(
    emailStoreLayerAtPath(databasePath),
    emailWaitStoreLayerAtPath(databasePath),
    EmailProjectCatalog.layerTest(projects),
    ServerSettings.layerTest({
      emailCapture: {
        ...DEFAULT_EMAIL_CAPTURE_SETTINGS,
        listener: { enabled: true, bindAddress: "127.0.0.1", port },
        projects: [
          projectSettings(alphaProjectId, "alpha"),
          projectSettings(betaProjectId, "beta"),
        ],
      },
    }),
  );
  return Layer.merge(dependencies, emailCaptureLayer.pipe(Layer.provide(dependencies)));
};

const sendMail = (input: {
  readonly port: number;
  readonly authUsername?: string;
  readonly to: string;
  readonly subject: string;
  readonly text?: string;
  readonly raw?: string;
  readonly attachment?: { readonly filename: string; readonly content: string };
  readonly requireTls?: boolean;
}) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      nodemailer.createTransport({
        host: "127.0.0.1",
        port: input.port,
        secure: false,
        requireTLS: input.requireTls ?? false,
        ignoreTLS: !(input.requireTls ?? false),
        tls: { rejectUnauthorized: false },
        ...(input.authUsername === undefined
          ? {}
          : { auth: { user: input.authUsername, pass: "accepted-without-validation" } }),
      }),
    ),
    (transport) =>
      Effect.tryPromise({
        try: () =>
          transport.sendMail(
            input.raw === undefined
              ? {
                  from: "sender@example.com",
                  to: input.to,
                  subject: input.subject,
                  text: input.text ?? "Verification code 123456",
                  attachments:
                    input.attachment === undefined
                      ? []
                      : [
                          {
                            filename: input.attachment.filename,
                            content: input.attachment.content,
                          },
                        ],
                }
              : {
                  envelope: { from: "sender@example.com", to: [input.to] },
                  raw: input.raw,
                },
          ),
        catch: (cause) => cause,
      }),
    (transport) => Effect.sync(() => transport.close()),
  );

const sendAndReceive = Effect.fn("sendAndReceive")(function* (
  capture: EmailCaptureService["Service"],
  input: Parameters<typeof sendMail>[0],
) {
  const receiptStream = yield* capture.subscribeReceipts;
  const receiptFiber = yield* receiptStream.pipe(
    Stream.filter(
      (receipt): receipt is Extract<EmailCaptureReceipt, { readonly _tag: "EmailMessageStored" }> =>
        receipt._tag === "EmailMessageStored",
    ),
    Stream.runHead,
    Effect.fork,
  );
  yield* sendMail(input);
  return Option.getOrThrow(yield* Fiber.join(receiptFiber));
});

describe("EmailCaptureService SMTP listener", () => {
  it.effect("captures real mail for every routing rule, malformed MIME, and attachments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "pathway-smtp-capture-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );
        const port = yield* freePort;
        yield* Effect.gen(function* () {
          const capture = yield* EmailCaptureService;
          const store = yield* EmailStore;
          yield* capture.start;
          expect((yield* capture.status).state).toBe("listening");

          const auth = yield* sendAndReceive(capture, {
            port,
            authUsername: "alpha",
            to: "person@example.com",
            subject: "AUTH route",
            requireTls: true,
          });
          const domain = yield* sendAndReceive(capture, {
            port,
            to: "person@beta.test",
            subject: "Domain route",
          });
          const plus = yield* sendAndReceive(capture, {
            port,
            to: "person+alpha@example.com",
            subject: "Plus route",
          });
          const unmatched = yield* sendAndReceive(capture, {
            port,
            to: "person@example.com",
            subject: "Unassigned route",
          });
          const malformed = yield* sendAndReceive(capture, {
            port,
            to: "broken@beta.test",
            subject: "Malformed",
            raw: [
              "From: sender@example.com",
              "To: broken@beta.test",
              "Subject: malformed boundary",
              "Content-Type: multipart/mixed; boundary=missing-close",
              "",
              "--missing-close",
              "Content-Type: text/plain",
              "",
              "still captured",
            ].join("\r\n"),
          });
          const attachment = yield* sendAndReceive(capture, {
            port,
            to: "files@beta.test",
            subject: "Attachment",
            attachment: { filename: "proof.txt", content: "attachment persisted" },
          });

          const messages = yield* Effect.forEach(
            [auth, domain, plus, unmatched, malformed, attachment],
            (receipt) => store.getMessage(receipt.messageId),
          );
          assert(messages.every((message) => message !== null));
          expect(messages.map((message) => message?.attribution.matchedBy)).toEqual([
            "auth-username",
            "recipient-domain",
            "recipient-plus-tag",
            "unassigned",
            "recipient-domain",
            "recipient-domain",
          ]);
          expect(messages[0]?.envelope.authUsername).toBe("alpha");
          expect(messages[4]?.textBody).toContain("still captured");
          expect(messages[5]?.attachments[0]?.filename).toBe("proof.txt");
          expect(messages[5]?.isRead).toBe(false);
          expect(
            messages[0]?.smtpTransactionLog.some(({ line }) => line.startsWith("AUTH PLAIN")),
          ).toBe(true);
          expect(existsSync(join(directory, "mail", "raw", `${attachment.messageId}.eml`))).toBe(
            true,
          );
          const attachmentId = messages[5]?.attachments[0]?.id;
          assert(attachmentId !== undefined);
          expect(
            existsSync(join(directory, "mail", "attachments", attachment.messageId, attachmentId)),
          ).toBe(true);

          const markedRead = yield* capture.markRead(
            { type: "message", messageId: attachment.messageId },
            true,
          );
          expect(markedRead.updatedMessageIds).toEqual([attachment.messageId]);
          expect((yield* store.getMessage(attachment.messageId))?.isRead).toBe(true);
          yield* capture.markRead({ type: "message", messageId: attachment.messageId }, false);
          expect((yield* store.getMessage(attachment.messageId))?.isRead).toBe(false);

          const clearReceipts = yield* capture.subscribeReceipts;
          const clearFiber = yield* clearReceipts.pipe(
            Stream.filter((receipt) => receipt._tag === "EmailInboxClearCompleted"),
            Stream.runHead,
            Effect.fork,
          );
          const cleared = yield* capture.clearInbox({ type: "project", projectId: betaProjectId });
          const clearReceipt = Option.getOrThrow(yield* Fiber.join(clearFiber));
          expect(clearReceipt._tag).toBe("EmailInboxClearCompleted");
          expect(cleared.clearedCount).toBe(3);
          expect(existsSync(join(directory, "mail", "raw", `${attachment.messageId}.eml`))).toBe(
            false,
          );
        }).pipe(
          Effect.provide(layerFor(join(directory, "mail.sqlite"), port)),
          Effect.provide(NodeServices.layer),
        );
      }),
    ),
  );
});
