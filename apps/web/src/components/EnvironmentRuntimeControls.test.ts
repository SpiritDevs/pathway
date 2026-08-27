import type { KnownTerminalSession } from "@spiritdevs/client-runtime/state/terminal";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TerminalRow } from "./EnvironmentRuntimeControls";
import { selectActiveTerminalSessions } from "./EnvironmentRuntimeControls.logic";

function terminalSession(
  terminalId: string,
  status: KnownTerminalSession["state"]["status"],
): KnownTerminalSession {
  return {
    target: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId,
    },
    state: {
      summary: null,
      buffer: "",
      bufferEpoch: 0,
      bufferOffset: 0,
      status,
      error: null,
      hasRunningSubprocess: status === "running",
      updatedAt: null,
      version: 0,
    },
  };
}

describe("selectActiveTerminalSessions", () => {
  it("keeps starting and running terminals while excluding settled sessions", () => {
    const sessions = [
      terminalSession("term-1", "starting"),
      terminalSession("term-2", "running"),
      terminalSession("term-3", "exited"),
      terminalSession("term-4", "error"),
      terminalSession("term-5", "closed"),
    ];

    expect(
      selectActiveTerminalSessions(sessions).map((session) => session.target.terminalId),
    ).toEqual(["term-1", "term-2"]);
  });
});

describe("TerminalRow", () => {
  it("shows a trash action that kills the terminal", () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalRow, {
        session: terminalSession("term-1", "running"),
        onOpen: () => {},
        onKill: () => {},
        killing: false,
      }),
    );

    expect(markup).toContain('aria-label="Kill Terminal 1"');
    expect(markup).toContain('title="Kill terminal"');
    expect(markup).toContain("lucide-trash-2");
  });

  it("disables the action while the terminal is being killed", () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalRow, {
        session: terminalSession("term-1", "running"),
        onOpen: () => {},
        onKill: () => {},
        killing: true,
      }),
    );

    expect(markup).toContain("disabled");
    expect(markup).toContain("lucide-loader-circle");
  });
});
