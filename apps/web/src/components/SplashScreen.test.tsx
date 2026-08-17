import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SplashScreen } from "./SplashScreen";
import { APP_LOADING_MESSAGES } from "./splashScreen.logic";

describe("SplashScreen", () => {
  it("names what it is waiting on", () => {
    const html = renderToStaticMarkup(<SplashScreen reason="environment" />);

    expect(html).toContain(APP_LOADING_MESSAGES.environment);
    expect(html).toContain('role="status"');
  });

  it("keeps the icon and the bottom spinner the boot shell painted", () => {
    const html = renderToStaticMarkup(<SplashScreen reason="account" />);

    expect(html).toContain('class="boot-logo"');
    expect(html).toContain("/apple-touch-icon.png");
    expect(html).toContain('class="boot-spinner"');
  });

  it("resumes the boot timeline instead of restarting it", () => {
    const html = renderToStaticMarkup(<SplashScreen reason="profile" />);
    const delays = [...html.matchAll(/animation-delay:(-?[\d.]+)ms/g)].map((match) =>
      Number(match[1]),
    );

    expect(delays).toHaveLength(2);
    // Mounting mid-boot rewinds both animations by however long the page has
    // been up, so the lift is already partway (or done) rather than starting
    // over, and the message stays its fixed beat behind the lift.
    const [lift, message] = delays as [number, number];
    expect(lift).toBeLessThan(0);
    expect(message - lift).toBe(220);
  });
});
