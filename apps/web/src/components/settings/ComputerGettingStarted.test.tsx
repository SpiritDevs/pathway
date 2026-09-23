import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const storage = vi.hoisted(() => ({ acknowledged: false, write: vi.fn() }));
vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: () => [storage.acknowledged, storage.write],
}));

import { ComputerGettingStarted } from "./ComputerGettingStarted";

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
});
