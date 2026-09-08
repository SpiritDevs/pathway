#!/usr/bin/env node
// @effect-diagnostics globalConsole:off globalFetch:off - Standalone Node deployment preflight.
import { mailStorageApiKey } from "../src/mail/storage.ts";

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
}
