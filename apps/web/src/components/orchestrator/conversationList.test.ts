import { describe, expect, it } from "vite-plus/test";
import {
  unreadMessageTotal,
  unreadLabel,
  conversationTime,
  conversationPanelLayout,
  conversationDetailsLayout,
} from "./conversationList";

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

it("keeps the slide-out attached and confines the overlay to the companion", () => {
  const bounds = { left: 100, top: 80, height: 600, width: 500 };
  expect(conversationPanelLayout(bounds)).toEqual({
    docked: false,
    left: 100,
    top: 80,
    width: 500,
    height: 600,
    panelWidth: 320,
  });
  expect(conversationPanelLayout({ ...bounds, left: 336 })).toEqual({
    docked: true,
    left: 16,
    top: 80,
    width: 320,
    height: 600,
    panelWidth: 320,
  });
  expect(conversationPanelLayout({ ...bounds, width: 280 }).panelWidth).toBe(240);
});

it("attaches details to the right when there is room and otherwise contains them", () => {
  const bounds = { left: 100, top: 80, width: 600, height: 500 };
  expect(conversationDetailsLayout(bounds, 1056)).toEqual({
    docked: true,
    left: 700,
    top: 80,
    width: 340,
    height: 500,
    panelWidth: 340,
  });
  expect(conversationDetailsLayout(bounds, 1055)).toEqual({
    docked: false,
    left: 100,
    top: 80,
    width: 600,
    height: 500,
    panelWidth: 340,
  });
  expect(conversationDetailsLayout({ ...bounds, width: 280 }, 400).panelWidth).toBe(240);
});
