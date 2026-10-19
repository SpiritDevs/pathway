import type { KnownTerminalSession } from "@spiritdevs/client-runtime/state/terminal";

export function selectActiveTerminalSessions(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<KnownTerminalSession> {
  return sessions.filter(
    (session) => session.state.status === "starting" || session.state.status === "running",
  );
}
