import { describe, expect, it, vi } from "vite-plus/test";
import { focusComposerOnDialogClose, resolveComposerHandle } from "./composerHandleContext";

describe("collapsed composer handles", () => {
  it("restores the palette trigger when there is no composer to focus", () => {
    expect(focusComposerOnDialogClose(null)).toBe(true);
  });

  it("focuses an expanded composer instead of the palette trigger", () => {
    const handle = { focusAtEnd: vi.fn() };
    expect(focusComposerOnDialogClose(handle)).toBe(false);
    expect(handle.focusAtEnd).toHaveBeenCalledOnce();
  });
  it("mounts before an insertion so the first keystroke or file mention is retained", () => {
    const handle = { insertTextAtEnd: vi.fn((_text: string) => true) };
    const ref = {
      current: null as typeof handle | null,
      reveal: () => {
        ref.current = handle;
      },
    };
    expect(resolveComposerHandle(ref)?.insertTextAtEnd("x")).toBe(true);
    expect(handle.insertTextAtEnd).toHaveBeenCalledExactlyOnceWith("x");
  });

  it("uses the mounted handle without revealing again", () => {
    const handle = { focusAtEnd: vi.fn() };
    const ref = { current: handle, reveal: vi.fn() };
    resolveComposerHandle(ref)?.focusAtEnd();
    expect(handle.focusAtEnd).toHaveBeenCalledOnce();
    expect(ref.reveal).not.toHaveBeenCalled();
  });

  it("does not invent a handle for a native child or unresolved ownership", () => {
    expect(resolveComposerHandle({ current: null })).toBeNull();
  });
});
