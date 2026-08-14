import { describe, expect, it } from "vite-plus/test";

import { resolveClerkSignInProps } from "./authRedirect";

describe("resolveClerkSignInProps", () => {
  it("returns to the current browser URL on the web", () => {
    const href = "https://app.spiritdevs.com/connect?state=state-1#details";
    expect(resolveClerkSignInProps(href, false)).toEqual({ forceRedirectUrl: href });
  });

  it("removes a Clerk virtual pathname and callback params while preserving the desktop route", () => {
    expect(
      resolveClerkSignInProps(
        "pathway://app/CLERK-ROUTER/VIRTUAL/sign-up?__clerk_status=complete#/settings/connections",
        true,
      ),
    ).toEqual({
      forceRedirectUrl: "pathway://app/#/settings/connections",
      signUpForceRedirectUrl: "pathway://app/#/settings/connections",
    });
  });

  it("preserves a clean development desktop route", () => {
    expect(resolveClerkSignInProps("pathway-dev://app/#/settings/general", true)).toEqual({
      forceRedirectUrl: "pathway-dev://app/#/settings/general",
      signUpForceRedirectUrl: "pathway-dev://app/#/settings/general",
    });
  });
});
