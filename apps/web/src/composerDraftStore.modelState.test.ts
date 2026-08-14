import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@spiritdevs/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@spiritdevs/contracts/settings";
import { createModelSelection } from "@spiritdevs/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveComposerControlsLocked,
  deriveEffectiveComposerModelState,
  derivePersistableComposerModelSelection,
  deriveSubagentComposerModelSelection,
} from "./composerDraftStore";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const THREAD_ID = ThreadId.make("thread-child");

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: CLAUDE_INSTANCE,
    driver: CLAUDE,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-14T00:00:00.000Z",
    models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  },
];

const threadSelection = createModelSelection(CLAUDE_INSTANCE, "claude-fable-5", [
  { id: "effort", value: "high" },
  { id: "contextWindow", value: "1m" },
]);

function runtimeSubagent(input?: {
  childThreadId?: ThreadId | null;
  model?: string | null;
  effort?: string | null;
  options?: ReadonlyArray<{ id: string; value: string | boolean }> | null;
}) {
  const has = (key: keyof NonNullable<typeof input>) =>
    input !== undefined && Object.prototype.hasOwnProperty.call(input, key);
  return {
    childThreadId: has("childThreadId") ? (input?.childThreadId ?? null) : THREAD_ID,
    driver: CLAUDE,
    model: has("model") ? (input?.model ?? null) : "opus",
    effort: has("effort") ? (input?.effort ?? null) : "max",
    options: has("options") ? (input?.options ?? null) : null,
  };
}

function deriveEffective(input?: {
  draftSelection?: ReturnType<typeof createModelSelection>;
  subagentSelection?: ReturnType<typeof createModelSelection> | null;
}) {
  const draftSelection = input?.draftSelection;
  return deriveEffectiveComposerModelState({
    draft: draftSelection
      ? {
          activeProvider: CLAUDE_INSTANCE,
          modelSelectionByProvider: { [CLAUDE_INSTANCE]: draftSelection },
        }
      : null,
    providers,
    selectedProvider: CLAUDE,
    selectedInstanceId: CLAUDE_INSTANCE,
    subagentModelSelection: input?.subagentSelection,
    threadModelSelection: threadSelection,
    projectModelSelection: createModelSelection(CLAUDE_INSTANCE, "claude-sonnet-5"),
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
}

describe("subagent composer model state", () => {
  it("locks controls for provider-native subagent children", () => {
    expect(
      deriveComposerControlsLocked({
        relationshipToParent: "subagent",
        matchedSubagentOrigin: "provider_native",
      }),
    ).toBe(true);
  });

  it("keeps controls enabled for app-owned subagent children", () => {
    expect(
      deriveComposerControlsLocked({
        relationshipToParent: "subagent",
        matchedSubagentOrigin: "app_owned",
      }),
    ).toBe(false);
  });

  it("fails open when subagent lineage has no matched parent record", () => {
    expect(
      deriveComposerControlsLocked({
        relationshipToParent: "subagent",
        matchedSubagentOrigin: null,
      }),
    ).toBe(false);
  });

  it("keeps non-subagent thread controls enabled", () => {
    expect(
      deriveComposerControlsLocked({
        relationshipToParent: "fork",
        matchedSubagentOrigin: "provider_native",
      }),
    ).toBe(false);
  });

  it("matches roster metadata to the child thread and keeps the child provider instance", () => {
    const customInstance = ProviderInstanceId.make("claude_work");
    const selection = deriveSubagentComposerModelSelection({
      threadId: THREAD_ID,
      relationshipToParent: "subagent",
      providerInstanceId: customInstance,
      threadModelSelection: threadSelection,
      parentThreadModelSelection: createModelSelection(CLAUDE_INSTANCE, "claude-fable-5", [
        { id: "effort", value: "high" },
        { id: "contextWindow", value: "1m" },
      ]),
      runtimeSubagents: [runtimeSubagent()],
    });

    expect(selection).toEqual(
      createModelSelection(customInstance, "opus", [{ id: "effort", value: "max" }]),
    );
  });

  it("ignores roster entries for a different child thread", () => {
    expect(
      deriveSubagentComposerModelSelection({
        threadId: THREAD_ID,
        relationshipToParent: "subagent",
        providerInstanceId: CLAUDE_INSTANCE,
        threadModelSelection: threadSelection,
        parentThreadModelSelection: threadSelection,
        runtimeSubagents: [runtimeSubagent({ childThreadId: ThreadId.make("thread-other") })],
      }),
    ).toBeNull();
  });

  it("maps the roster raw model slug and uses roster options ahead of the thread record", () => {
    const subagentSelection = deriveSubagentComposerModelSelection({
      threadId: THREAD_ID,
      relationshipToParent: "subagent",
      providerInstanceId: CLAUDE_INSTANCE,
      threadModelSelection: threadSelection,
      parentThreadModelSelection: threadSelection,
      runtimeSubagents: [
        runtimeSubagent({
          options: [
            { id: "effort", value: "xhigh" },
            { id: "contextWindow", value: "200k" },
          ],
        }),
      ],
    });

    expect(deriveEffective({ subagentSelection })).toEqual({
      selectedModel: "claude-opus-5",
      modelOptions: {
        [CLAUDE_INSTANCE]: [
          { id: "effort", value: "xhigh" },
          { id: "contextWindow", value: "200k" },
        ],
      },
      modelSelectionSource: "subagent_roster",
    });
  });

  it("marks a roster-derived selection as non-persistable", () => {
    const subagentSelection = createModelSelection(CLAUDE_INSTANCE, "opus", [
      { id: "effort", value: "max" },
    ]);
    const effective = deriveEffective({ subagentSelection });
    const selection = createModelSelection(
      CLAUDE_INSTANCE,
      effective.selectedModel,
      effective.modelOptions?.[CLAUDE_INSTANCE],
    );

    expect(effective.modelSelectionSource).toBe("subagent_roster");
    expect(
      derivePersistableComposerModelSelection({
        modelSelection: selection,
        source: effective.modelSelectionSource,
      }),
    ).toBeUndefined();
  });

  it("keeps an explicit per-thread draft ahead of roster metadata", () => {
    const draftSelection = createModelSelection(CLAUDE_INSTANCE, "claude-sonnet-5", [
      { id: "effort", value: "low" },
      { id: "contextWindow", value: "1m" },
    ]);
    const subagentSelection = createModelSelection(CLAUDE_INSTANCE, "opus", [
      { id: "effort", value: "max" },
    ]);

    const effective = deriveEffective({ draftSelection, subagentSelection });
    expect(effective).toEqual({
      selectedModel: "claude-sonnet-5",
      modelOptions: {
        [CLAUDE_INSTANCE]: [
          { id: "effort", value: "low" },
          { id: "contextWindow", value: "1m" },
        ],
      },
      modelSelectionSource: "draft",
    });
    expect(
      derivePersistableComposerModelSelection({
        modelSelection: draftSelection,
        source: effective.modelSelectionSource,
      }),
    ).toEqual(draftSelection);
  });

  it("does not leak roster options through an explicit draft with default options", () => {
    const draftSelection = createModelSelection(CLAUDE_INSTANCE, "claude-sonnet-5");
    const subagentSelection = createModelSelection(CLAUDE_INSTANCE, "opus", [
      { id: "effort", value: "max" },
    ]);

    expect(deriveEffective({ draftSelection, subagentSelection })).toEqual({
      selectedModel: "claude-sonnet-5",
      modelOptions: null,
      modelSelectionSource: "draft",
    });
  });

  it("skips stale roster metadata once the child selection diverges from its parent", () => {
    const deliberateChildSelection = createModelSelection(CLAUDE_INSTANCE, "claude-sonnet-5");

    expect(
      deriveSubagentComposerModelSelection({
        threadId: THREAD_ID,
        relationshipToParent: "subagent",
        providerInstanceId: CLAUDE_INSTANCE,
        threadModelSelection: deliberateChildSelection,
        parentThreadModelSelection: threadSelection,
        runtimeSubagents: [runtimeSubagent()],
      }),
    ).toBeNull();
  });

  it("preserves an explicit null roster model and falls back only to the inherited thread model", () => {
    expect(
      deriveSubagentComposerModelSelection({
        threadId: THREAD_ID,
        relationshipToParent: "subagent",
        providerInstanceId: CLAUDE_INSTANCE,
        threadModelSelection: threadSelection,
        parentThreadModelSelection: threadSelection,
        runtimeSubagents: [runtimeSubagent({ model: null })],
      }),
    ).toEqual(
      createModelSelection(CLAUDE_INSTANCE, "claude-fable-5", [{ id: "effort", value: "max" }]),
    );
  });

  it("preserves an explicit null roster effort instead of applying the helper default", () => {
    expect(
      deriveSubagentComposerModelSelection({
        threadId: THREAD_ID,
        relationshipToParent: "subagent",
        providerInstanceId: CLAUDE_INSTANCE,
        threadModelSelection: threadSelection,
        parentThreadModelSelection: threadSelection,
        runtimeSubagents: [runtimeSubagent({ effort: null })],
      }),
    ).toEqual(createModelSelection(CLAUDE_INSTANCE, "opus"));
  });

  it("falls back to the thread record when no roster metadata is available", () => {
    expect(deriveEffective()).toEqual({
      selectedModel: "claude-fable-5",
      modelOptions: {
        [CLAUDE_INSTANCE]: [
          { id: "effort", value: "high" },
          { id: "contextWindow", value: "1m" },
        ],
      },
      modelSelectionSource: "thread",
    });
  });
});
