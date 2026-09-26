import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const storage = vi.hoisted(() => ({ acknowledged: false, write: vi.fn() }));
vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: () => [storage.acknowledged, storage.write],
}));
// Rendering the component as a plain function needs a hook outside React.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <T,>(initial: T) => [initial, () => undefined],
}));

import { ComputerGettingStarted } from "./ComputerGettingStarted";

/** The element whose only child is `label`, searched through props.children. */
function findByText(node: ReactNode, label: string): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByText(child, label);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.props.children === label) return element;
  return findByText(element.props.children, label);
}

afterEach(() => {
  storage.acknowledged = false;
  storage.write.mockReset();
});

describe("ComputerGettingStarted", () => {
  it("introduces explicit task requests and explains that hiding the preview does not stop control", () => {
    const markup = renderToStaticMarkup(<ComputerGettingStarted snapShotAvailable={true} />);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("/computer-use open Calculator");
    expect(markup).toContain("for that request only");
    expect(markup).toContain("Use Stop in the chat");
    expect(markup).toContain("Closing the preview only hides it");
    expect(markup).toContain("SnapShot is separate");
    expect(markup).toContain("Got it");
    expect(markup).not.toContain('role="dialog"');
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged guide collapsed but available to reopen", () => {
    storage.acknowledged = true;
    const markup = renderToStaticMarkup(<ComputerGettingStarted snapShotAvailable={false} />);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Show guide");
    expect(markup).not.toContain("Got it");
    expect(markup).not.toContain("SnapShot is separate");
  });

  it("remembers the acknowledgement when Got it is pressed", () => {
    const section = ComputerGettingStarted({ snapShotAvailable: false });
    const gotIt = findByText(section.props.children, "Got it");
    (gotIt?.props as { onClick: () => void }).onClick();
    expect(storage.write).toHaveBeenCalledExactlyOnceWith(true);
  });
});
