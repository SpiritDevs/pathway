import { describe, expect, it } from "vite-plus/test";

import { STRUCTURED_VALUE_PREVIEW_CHARS, structuredValuePreview } from "./V2ItemInspector";

describe("structuredValuePreview", () => {
  it("shows a short value whole", () => {
    expect(structuredValuePreview("exit 0", false)).toBe("exit 0");
  });

  it("keeps only the tail of long output until asked for all of it", () => {
    const output = Array.from({ length: 5_000 }, (_, line) => `line ${line}`).join("\n");
    const preview = structuredValuePreview(output, false);
    expect(preview).toHaveLength(STRUCTURED_VALUE_PREVIEW_CHARS);
    expect(output.endsWith(preview)).toBe(true);
    expect(structuredValuePreview(output, true)).toBe(output);
  });
});
