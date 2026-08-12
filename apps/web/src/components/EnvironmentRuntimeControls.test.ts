import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

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
