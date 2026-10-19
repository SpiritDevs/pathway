import { scopedThreadKey, scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { COMPOSER_DRAFT_STORAGE_KEY, useComposerDraftStore } from "./composerDraftStore";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_REF = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-computer"));
const OTHER_REF = scopeThreadRef(EnvironmentId.make("environment-remote"), THREAD_REF.threadId);

function reset() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function draft(ref = THREAD_REF) {
  return useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(ref)];
}

type PersistApi = {
  getOptions: () => {
    storage: {
      flush: () => void;
      getItem: (name: string) => {
        state: { draftsByThreadKey?: Record<string, Record<string, unknown>> };
      } | null;
    };
    merge: (
      persisted: unknown,
      current: ReturnType<typeof useComposerDraftStore.getState>,
    ) => ReturnType<typeof useComposerDraftStore.getState>;
  };
};
const persistApi = useComposerDraftStore.persist as unknown as PersistApi;

describe("composer draft Computer intent", () => {
  beforeEach(reset);

  it("stores the mode and generation per environment-scoped thread", () => {
    const store = useComposerDraftStore.getState();
    store.setComputerControlMode(THREAD_REF, "request", { generation: 4 });
    store.setComputerControlMode(OTHER_REF, "chat", { generation: 1 });

    expect(draft()).toMatchObject({ computerControlMode: "request", computerControlGeneration: 4 });
    expect(draft(OTHER_REF)).toMatchObject({
      computerControlMode: "chat",
      computerControlGeneration: 1,
    });
  });

  it("keeps the last generation when a reset only changes the mode", () => {
    const store = useComposerDraftStore.getState();
    store.setComputerControlMode(THREAD_REF, "request", { generation: 2 });
    store.setComputerControlMode(THREAD_REF, "off");

    expect(draft()).toMatchObject({ computerControlMode: "off", computerControlGeneration: 2 });
  });

  it("round-trips an explicit choice through persistence, including Off", () => {
    useComposerDraftStore.getState().setComputerControlMode(THREAD_REF, "off", { generation: 3 });
    const storage = persistApi.getOptions().storage;
    storage.flush();
    const persisted = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)?.state;
    expect(persisted?.draftsByThreadKey?.[scopedThreadKey(THREAD_REF)]).toMatchObject({
      computerControlMode: "off",
      computerControlGeneration: 3,
    });

    reset();
    const merged = persistApi
      .getOptions()
      .merge(persisted, useComposerDraftStore.getInitialState());
    expect(merged.draftsByThreadKey[scopedThreadKey(THREAD_REF)]).toMatchObject({
      computerControlMode: "off",
      computerControlGeneration: 3,
    });
  });

  it("drops malformed persisted Computer fields", () => {
    const merged = persistApi.getOptions().merge(
      {
        draftsByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            prompt: "hello",
            attachments: [],
            computerControlMode: "always",
            computerControlGeneration: -1,
          },
        },
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    );
    const hydrated = merged.draftsByThreadKey[scopedThreadKey(THREAD_REF)];
    expect(hydrated?.prompt).toBe("hello");
    expect(hydrated?.computerControlMode).toBeUndefined();
    expect(hydrated?.computerControlGeneration).toBeUndefined();
  });
});
