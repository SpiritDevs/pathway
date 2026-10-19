import { describe, expect, it } from "vite-plus/test";
import { resolveByteRange } from "./ByteRange.ts";

describe("media byte ranges", () => {
  it("serves bounded, open-ended, and suffix ranges for seeking", () => {
    expect(resolveByteRange("bytes=0-1", 100)).toEqual({ status: 206, start: 0, length: 2 });
    expect(resolveByteRange("bytes=90-", 100)).toEqual({ status: 206, start: 90, length: 10 });
    expect(resolveByteRange("bytes=-12", 100)).toEqual({ status: 206, start: 88, length: 12 });
    expect(resolveByteRange("bytes=90-999", 100)).toEqual({ status: 206, start: 90, length: 10 });
    expect(resolveByteRange("bytes=-999", 100)).toEqual({ status: 206, start: 0, length: 100 });
  });
  it.each([
    "bytes=100-",
    "bytes=3-2",
    "bytes=-0",
    "bytes=-",
    "bytes=bad",
    "bytes=999999999999999999999-",
  ])("rejects an unsatisfiable range %s", (header) => {
    expect(resolveByteRange(header, 100)).toEqual({ status: 416 });
  });
  it("handles empty files and ignores unsupported multipart requests", () => {
    expect(resolveByteRange("bytes=0-", 0)).toEqual({ status: 416 });
    expect(resolveByteRange(undefined, 100)).toEqual({ status: 200 });
    expect(resolveByteRange("bytes=0-1,5-9", 100)).toEqual({ status: 200 });
    expect(resolveByteRange("items=0-1", 100)).toEqual({ status: 200 });
  });
});
