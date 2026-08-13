import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EmailDetectedCodeButton } from "./EmailMessageList";

describe("EmailDetectedCodeButton", () => {
  it("exposes a detected code as a clipboard action", () => {
    const markup = renderToStaticMarkup(<EmailDetectedCodeButton code="4JJVYX" />);

    expect(markup).toMatch(/<button[^>]*aria-label="Copy verification code 4JJVYX"/);
    expect(markup).toContain('title="Copy verification code"');
    expect(markup).toContain("4JJVYX");
  });
});
