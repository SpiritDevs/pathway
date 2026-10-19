import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { conversationStorageBanner } from "./ConversationStorageBanner";

const storage = () => ({
  reclaimed: false,
  error: null,
  running: false,
  recreateWorktree: vi.fn(async () => {}),
  pressure: "critical" as const,
  allowed: false,
  allow: vi.fn(),
});

describe("conversationStorageBanner", () => {
  it("shows a compact dismissible warning only before the first message", () => {
    const state = storage();
    const input = { storage: state, environmentLabel: "Macbook Pro M1", hasMessages: false };
    const banner = conversationStorageBanner(input);
    expect(banner?.presentation).toBe("lip");
    expect(renderToStaticMarkup(<>{banner?.title}</>)).toContain(
      "Macbook Pro M1 - Critical Storage",
    );
    expect(banner?.description).toBeUndefined();
    banner?.onDismiss?.();
    expect(state.allow).toHaveBeenCalledOnce();
    expect(conversationStorageBanner({ ...input, hasMessages: true })).toBeNull();
    expect(
      conversationStorageBanner({ ...input, storage: { ...state, allowed: true } }),
    ).toBeNull();
    expect(
      conversationStorageBanner({ ...input, storage: { ...state, pressure: "healthy" } }),
    ).toBeNull();
  });
});
