import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AuthShell } from "./AuthShell";

describe("AuthShell", () => {
  it("keeps the blue blueprint artwork in production-rendered auth markup", () => {
    const markup = renderToStaticMarkup(<AuthShell>Sign in</AuthShell>);

    expect(markup).toContain("stage-blueprint");
  });
});
