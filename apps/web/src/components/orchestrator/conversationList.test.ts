import { describe, expect, it } from "vite-plus/test";
import { unreadMessageTotal, unreadLabel, conversationTime } from "./conversationList";

describe("conversation list", () => {
  it("counts messages rather than rooms, excludes archived rooms, and caps the badge", () => {
    const count = unreadMessageTotal([
      { archived: false, unreadCount: 4 },
      { archived: false, unreadCount: 2 },
      { archived: true, unreadCount: 40 },
      { archived: false },
    ]);
    expect(count).toBe(6);
    expect(unreadLabel(count)).toBe("6");
    expect(unreadLabel(104)).toBe("99+");
    expect(unreadMessageTotal([])).toBe(0);
  });
  it("shows send times today and dates for older messages", () => {
    const now = new Date(2026, 8, 15, 12).getTime();
    const today = new Date(2026, 8, 15, 10, 42);
    expect(conversationTime(today.getTime(), now)).toBe(
      new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(today),
    );
    const old = new Date(2025, 8, 15);
    expect(conversationTime(old.getTime(), now)).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(old),
    );
  });
});
