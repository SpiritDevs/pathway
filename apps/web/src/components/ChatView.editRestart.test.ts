// @effect-diagnostics nodeBuiltinImport:off - Runs ChatView's own edit-and-restart callback, which only exists inside the component.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

import { describe, expect, it, vi } from "vite-plus/test";

import { isBareComputerUseInvocation } from "./chat/composerSlashCommands.logic";

// Mounting ChatView needs the whole app, so this compiles the production
// callback out of the component source and runs it against stub closures.
function loadEditRestart(deps: Record<string, unknown>) {
  const source = NodeFS.readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
  const marker = source.indexOf("  const onSubmitUserMessageEdit = useCallback(");
  const begin = source.indexOf("async (", marker);
  const end = source.indexOf("\n    },\n", begin) + "\n    }".length;
  expect(marker).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const callback = NodeModule.stripTypeScriptTypes(source.slice(begin, end));
  // oxlint-disable-next-line no-new-func -- evaluates the extracted production callback
  const factory = new Function(...Object.keys(deps), `return (${callback});`);
  return factory(...Object.values(deps)) as (messageId: string, text: string) => Promise<boolean>;
}

/** Stub closures for the callback, with the feedback and dispatch the test observes. */
function editRestartDeps(overrides: Record<string, unknown>) {
  return {
    queuedChat: { controls: new Map() },
    activeThread: { id: "thread" },
    isServerThread: true,
    editableUserMessageId: "message",
    latestRunSettled: true,
    sendInFlightRef: { current: false },
    isBareComputerUseInvocation,
    toastBareComputerUseInvocation: vi.fn(),
    serverProjection: { messages: [{ id: "message", attachments: [] }] },
    requireConversationStorage: () => true,
    setThreadError: () => {},
    computerControlChangeSequence: { current: 0 },
    appAtomRegistry: {},
    readComputerControlGenerationForSend: async () => 3,
    activeThreadRef: {},
    computerControlSetting: false,
    resolveComputerControlForSend: () => ({ mode: "off", fields: {} }),
    editAndRestartMessage: vi.fn(async () => ({ _tag: "Success" })),
    environmentId: "env",
    composerDraftTarget: "thread",
    ...overrides,
  };
}

describe("ChatView edit and restart", () => {
  it("keeps a bare /computer-use edit and explains that it needs a task", async () => {
    const deps = editRestartDeps({});
    const submit = loadEditRestart(deps);

    await expect(submit("message", "  /computer-use ")).resolves.toBe(false);

    expect(deps.editAndRestartMessage).not.toHaveBeenCalled();
    expect(deps.toastBareComputerUseInvocation).toHaveBeenCalledTimes(1);
    expect(deps.sendInFlightRef.current).toBe(false);
  });

  it("restarts a bare /computer-use edit when the original's attachments are the task", async () => {
    const deps = editRestartDeps({
      serverProjection: { messages: [{ id: "message", attachments: [{ id: "image" }] }] },
    });
    const submit = loadEditRestart(deps);

    await expect(submit("message", "/computer-use")).resolves.toBe(true);

    expect(deps.editAndRestartMessage).toHaveBeenCalledTimes(1);
    expect(deps.toastBareComputerUseInvocation).not.toHaveBeenCalled();
  });

  it("restarts a /computer-use edit that names its task", async () => {
    const deps = editRestartDeps({});
    const submit = loadEditRestart(deps);

    await expect(submit("message", "/computer-use open Calculator")).resolves.toBe(true);

    expect(deps.editAndRestartMessage).toHaveBeenCalledTimes(1);
  });
});
