import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarThreadRowShell } from "./SidebarThreadRowShell";

// Drives the shared near-viewport observer the way the browser would: one notification per
// observed row. The row's <li> is the only node with a ref, so it is the observed target.
let notify: IntersectionObserverCallback = () => undefined;
const listItem = { closest: () => null };

let renderer: ReactTestRenderer | null = null;
const handlers = {
  onClick: vi.fn(),
  onDoubleClick: vi.fn(),
  onActivate: vi.fn(),
  onContextMenu: vi.fn(),
  onShowDetails: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    vi.fn(function (callback: IntersectionObserverCallback) {
      notify = callback;
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
  vi.useFakeTimers();
  for (const handler of Object.values(handlers)) handler.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderRow(options: { detailsOpen?: boolean } = {}) {
  const element = (detailsOpen: boolean) => (
    <SidebarThreadRowShell
      variant="card"
      title="Fix the build"
      active={false}
      renaming={false}
      detailsOpen={detailsOpen}
      deferRendering
      {...handlers}
    >
      {() => (
        <>
          <span>Fix the build</span>
          <button type="button" aria-label="Settle thread" />
        </>
      )}
    </SidebarThreadRowShell>
  );
  act(() => {
    renderer = create(element(options.detailsOpen ?? false), {
      createNodeMock: () => listItem,
    });
  });
  // Test instances are cached per host fiber, so the same instance means the same DOM element.
  const primary = () => renderer!.root.findByProps({ role: "button" });
  const listItemClass = () => renderer!.root.findByType("li").props.className as string;
  const setDetailsOpen = (detailsOpen: boolean) =>
    act(() => renderer!.update(element(detailsOpen)));
  const bodyMounted = () =>
    primary().findAll((node) => node.props["aria-label"] === "Settle thread").length > 0;
  const setNear = (isIntersecting: boolean) =>
    act(() =>
      notify(
        [{ target: listItem, isIntersecting } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
  return { primary, listItemClass, bodyMounted, setNear, setDetailsOpen };
}

// A synthetic event as React would deliver it to the primary element. `inside` is false for events
// bubbling out of a portaled popup, whose DOM target is outside the row.
function rowEvent(init: { inside?: boolean; key?: string } = {}) {
  const currentTarget = {
    contains: () => init.inside ?? true,
    getBoundingClientRect: () => ({ left: 10, bottom: 40 }),
  };
  return {
    ...init,
    currentTarget,
    target: currentTarget,
    clientX: 5,
    clientY: 6,
    preventDefault: vi.fn(),
  };
}

describe("SidebarThreadRowShell", () => {
  it("keeps one primary element while the body mounts under a held press", () => {
    const row = renderRow();
    expect(row.bodyMounted()).toBe(false);
    const pressed = row.primary();
    const bodilessClass = row.listItemClass();
    // The press starts on the bodiless row; the observer reports it near before the release.
    act(() => row.primary().props.onFocus(rowEvent()));
    row.setNear(true);
    expect(row.bodyMounted()).toBe(true);
    expect(row.primary()).toBe(pressed);
    // The <li> holds the row's rem height in both states, so mounting moves nothing below it.
    expect(row.listItemClass()).toBe(bodilessClass);
    expect(bodilessClass).toContain("h-[5.125rem]");
    act(() => row.primary().props.onClick(rowEvent()));
    expect(handlers.onClick).toHaveBeenCalledOnce();
  });

  it("mounts nothing on focus and activates from the keyboard", () => {
    const row = renderRow();
    act(() => row.primary().props.onFocus(rowEvent()));
    expect(row.bodyMounted()).toBe(false);
    for (const key of ["Enter", " "]) {
      act(() => row.primary().props.onKeyDown(rowEvent({ key })));
    }
    expect(handlers.onActivate).toHaveBeenCalledTimes(2);
    act(() => row.primary().props.onKeyDown(rowEvent({ key: "ContextMenu" })));
    expect(handlers.onContextMenu).toHaveBeenCalledWith({ x: 10, y: 40 });
    expect(handlers.onShowDetails).not.toHaveBeenCalled();
  });

  it("asks for the details card from the keyboard and keeps the body while it is open", () => {
    const row = renderRow();
    act(() => row.primary().props.onKeyDown(rowEvent({ key: "i" })));
    expect(handlers.onShowDetails).toHaveBeenCalledOnce();
    expect(handlers.onActivate).not.toHaveBeenCalled();
    row.setDetailsOpen(true);
    expect(row.bodyMounted()).toBe(true);
    row.setDetailsOpen(false);
    expect(row.bodyMounted()).toBe(false);
  });

  it("leaves nothing behind when a press is cancelled", () => {
    const row = renderRow();
    const pressed = row.primary();
    act(() => row.primary().props.onFocus(rowEvent()));
    row.setNear(true);
    row.setNear(false);
    // Dragged off and released elsewhere: focus leaves, no click is dispatched.
    act(() => {
      row.primary().props.onBlur();
      vi.runAllTimers();
    });
    expect(handlers.onClick).not.toHaveBeenCalled();
    expect(row.bodyMounted()).toBe(false);
    expect(row.primary()).toBe(pressed);
    act(() => row.primary().props.onClick(rowEvent()));
    expect(handlers.onClick).toHaveBeenCalledOnce();
  });

  it("keeps the body, and Shift+Tab's entry control, while focus is inside it", () => {
    const row = renderRow();
    row.setNear(true);
    // The body's trailing controls sit inside the primary element, so Shift+Tab from the row below
    // reaches the last of them first.
    const settle = row.primary().findByProps({ "aria-label": "Settle thread" });
    act(() => row.primary().props.onFocus({ target: settle, currentTarget: {} }));
    row.setNear(false);
    expect(row.bodyMounted()).toBe(true);
    act(() => {
      row.primary().props.onBlur();
      vi.runAllTimers();
    });
    expect(row.bodyMounted()).toBe(false);
  });

  it("lets the body go once focus moves from a trailing control back to the row", () => {
    const row = renderRow();
    row.setNear(true);
    const settle = row.primary().findByProps({ "aria-label": "Settle thread" });
    act(() => row.primary().props.onFocus({ target: settle, currentTarget: {} }));
    // Shift+Tab from the control: blur, then focus on the primary element before the timer runs.
    act(() => {
      row.primary().props.onBlur();
      row.primary().props.onFocus(rowEvent());
    });
    row.setNear(false);
    expect(row.bodyMounted()).toBe(false);
  });

  it("ignores presses that bubble out of the body's popups", () => {
    const row = renderRow();
    row.setNear(true);
    const outside = rowEvent({ inside: false });
    act(() => {
      row.primary().props.onClick(outside);
      row.primary().props.onDoubleClick(outside);
      row.primary().props.onContextMenu(outside);
    });
    expect(handlers.onClick).not.toHaveBeenCalled();
    expect(handlers.onDoubleClick).not.toHaveBeenCalled();
    expect(handlers.onContextMenu).not.toHaveBeenCalled();
    expect(outside.preventDefault).not.toHaveBeenCalled();
  });
});
