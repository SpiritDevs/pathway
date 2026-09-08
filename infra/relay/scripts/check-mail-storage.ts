#!/usr/bin/env node
// @effect-diagnostics globalConsole:off globalFetch:off - Standalone Node deployment preflight.
import { mailStorageApiKey, makePrivateMailStorage } from "../src/mail/storage.ts";

if (process.env.MAIL_ENABLED === "true") {
  const credential = process.env.MAIL_UPLOADTHING_API_KEY?.trim() ?? "";
  const apiKey = mailStorageApiKey(credential);
  const format = credential.startsWith("sk_")
    ? "API key"
    : apiKey !== credential
      ? "V7 SDK token"
      : "unrecognized";
  console.log(`Mail storage credential format: ${format}`);
  if (!apiKey) throw new Error("MAIL_UPLOADTHING_API_KEY is missing.");
  const response = await fetch("https://api.uploadthing.com/v7/getAppInfo", {
    method: "POST",
    headers: { "content-type": "application/json", "x-uploadthing-api-key": apiKey },
    body: "{}",
    signal: AbortSignal.timeout(25_000),
  });
  console.log(`Mail storage authentication: HTTP ${response.status}`);
  if (!response.ok) {
    throw new Error(
      "UploadThing rejected the mail storage credential. Update MAIL_UPLOADTHING_API_KEY in the production environment before deploying.",
    );
  }
  const app = (await response.json()) as { defaultACL: string; allowACLOverride: boolean };
  console.log(
    `Mail storage default ACL: ${app.defaultACL}; ACL override allowed: ${app.allowACLOverride}`,
  );
  const preparedKeys: string[] = [];
  const storage = makePrivateMailStorage(
    credential,
    async (url, init) => {
      const result = await fetch(url, init);
      if (!result.ok) {
        // This probe uploads only the fixed test string below, never mailbox content.
        const detail = (await result.clone().text())
          .replaceAll(credential, "[redacted]")
          .replaceAll(apiKey, "[redacted]")
          .replace(/https?:\/\/[^\s"<>]+/g, "[url]")
          .slice(0, 500);
        console.error(`Mail storage probe failed: HTTP ${result.status}; ${detail}`);
      }
      return result;
    },
    async (key) => {
      preparedKeys.push(key);
    },
  );
  try {
    await storage.put(
      "pathway-mail-storage-check.txt",
      "text/plain",
      new TextEncoder().encode("Pathway private mail storage deployment check."),
    );
    console.log("Private mail storage upload: successful");
  } finally {
    await storage.delete(preparedKeys);
  }
}
