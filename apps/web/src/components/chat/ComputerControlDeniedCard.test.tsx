// Keeps the denial card's Enable wiring truthful: the button only shows while
// control is off, the card flips to a confirmation once on, and a device the
// pairing keeps out is told to re-pair instead.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComputerControlDeniedCard } from "./ComputerControlDeniedCard";
import { sessionLacksComputerAccess } from "./ComputerControlDeniedCard.logic";

describe("ComputerControlDeniedCard", () => {
  it("offers Enable only while control is off, and points at Settings", () => {
    const markup = renderToStaticMarkup(<ComputerControlDeniedCard onEnable={() => undefined} />);

    expect(markup).toContain("Computer control is off");
    expect(markup).toContain("Turn it on in Settings to let the agent use the desktop.");
    expect(markup).toContain(">Enable<");
    expect(markup).not.toContain("/computer-use");
  });

  it("hides Enable without a handler instead of rendering a dead button", () => {
    const markup = renderToStaticMarkup(<ComputerControlDeniedCard />);

    expect(markup).toContain("Computer control is off");
    expect(markup).toContain("Turn it on in Settings to let the agent use the desktop.");
    expect(markup).not.toContain(">Enable<");
  });

  it("flips to a confirmation with no Enable once control is on", () => {
    const markup = renderToStaticMarkup(
      <ComputerControlDeniedCard computerControlEnabled onEnable={() => undefined} />,
    );

    expect(markup).toContain("Computer control is on for this chat");
    expect(markup).toContain("send a fresh message to continue");
    expect(markup).not.toContain(">Enable<");
  });

  it("tells a device without Computer access to re-pair, with no Enable", () => {
    const markup = renderToStaticMarkup(
      <ComputerControlDeniedCard accessDenied onEnable={() => undefined} />,
    );

    expect(markup).toContain("Re-pair it with “Use Computer” enabled");
    expect(markup).not.toContain("Computer control is off");
    expect(markup).not.toContain(">Enable<");
  });
});

describe("sessionLacksComputerAccess", () => {
  it("blames the pairing only when the session's scopes are known and lack access", () => {
    expect(
      sessionLacksComputerAccess({ authenticated: true, scopes: ["orchestration:operate"] }),
    ).toBe(true);
    expect(
      sessionLacksComputerAccess({
        authenticated: true,
        scopes: ["orchestration:operate", "computer:operate"],
      }),
    ).toBe(false);
    expect(sessionLacksComputerAccess({ authenticated: true, scopes: ["access:write"] })).toBe(
      false,
    );
    expect(sessionLacksComputerAccess({ authenticated: true })).toBe(false);
    expect(sessionLacksComputerAccess({ authenticated: false, scopes: [] })).toBe(false);
    expect(sessionLacksComputerAccess(null)).toBe(false);
  });
});
