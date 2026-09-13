import { expect, it } from "vite-plus/test";
import type { Asset } from "@spiritdevs/contracts/assets";
import type { TimelineEntry } from "../../session-logic";
import { applyMigratedTimelineAssets } from "./migratedTimelineAssets";
const entry = {
  kind: "message",
  message: {
    id: "message",
    text: "Original message",
    attachments: [
      {
        type: "image",
        id: "historical",
        name: "old.png",
        previewUrl: "https://public.example/old.png",
      },
    ],
  },
} as unknown as TimelineEntry;
const asset = {
  id: "private-copy",
  companyId: "company",
  name: "private.png",
  mimeType: "image/png",
  byteSize: 20,
} as Asset;
it("replaces a verified alias without rewriting message or attachment identity", () => {
  const result = applyMigratedTimelineAssets(
    [entry],
    "company",
    new Map([["historical", asset]]),
  )[0];
  expect(result).toMatchObject({
    message: {
      id: "message",
      text: "Original message",
      attachments: [
        { type: "asset", id: "historical", assetId: "private-copy", companyId: "company" },
      ],
    },
  });
  expect(result?.kind === "message" && result.message.attachments?.[0]).not.toHaveProperty(
    "previewUrl",
  );
});
it("preserves existing presentation when no verified alias exists", () => {
  expect(applyMigratedTimelineAssets([entry], "company", new Map())[0]).toBe(entry);
});
it("never substitutes metadata from another company", () => {
  expect(
    applyMigratedTimelineAssets([entry], "other-company", new Map([["historical", asset]]))[0],
  ).toBe(entry);
});
