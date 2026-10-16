import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@spiritdevs/contracts";
import { EMPTY_V2_ITEM_SUPPORT } from "@spiritdevs/client-runtime/state/item-support";
import * as DateTime from "effect/DateTime";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const requests = vi.hoisted(() => ({
  load: vi.fn(),
  fetch: vi.fn((input: unknown) => input),
  connection: vi.fn(),
}));
vi.mock("@spiritdevs/client-runtime/state/threads", () => ({
  fetchEnvironmentToolOutput: requests.fetch,
}));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: requests.load } }));
vi.mock("../../state/session", () => ({ readPreparedConnection: requests.connection }));
vi.mock("../../state/v2ItemSupport", () => ({ useV2ItemSupport: () => EMPTY_V2_ITEM_SUPPORT }));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));

import {
  formatStructuredValuePreview,
  STRUCTURED_VALUE_PREVIEW_CHARS,
  structuredValuePreview,
  V2ItemInspector,
} from "./V2ItemInspector";

const environmentId = EnvironmentId.make("environment:remote");
const sourceThreadId = ThreadId.make("thread:source");
const now = DateTime.makeUnsafe("2026-10-07T00:00:00Z");
const output = `first\n${"x".repeat(8192)}\nlast`;
const row: OrchestrationV2ProjectedTurnItem = {
  position: 0,
  visibility: "inherited",
  sourceThreadId,
  sourceItemId: TurnItemId.make("tool:source"),
  item: {
    id: TurnItemId.make("tool:source"),
    threadId: sourceThreadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    type: "command_execution",
    status: "completed",
    title: null,
    input: "example",
    output,
    outputPreview: { totalBytes: 100_000, format: "text" },
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  },
};
const prepared = { environmentId };
let renderer: ReactTestRenderer | undefined;
const view = (projectedItem = row) =>
  createElement(V2ItemInspector, {
    projectedItem,
    environmentId,
    onOpenThread: () => {},
    onOpenTurnDiff: () => {},
  });
const expandButton = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) => String(button.props.children).startsWith("Show all"))!;
const outputText = () => renderer!.root.findAllByType("pre").at(-1)!.props.children;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests.load.mockReset();
  requests.fetch.mockClear();
  requests.connection.mockReset().mockReturnValue(prepared);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("structuredValuePreview", () => {
  it("shows a short value whole", () => {
    expect(structuredValuePreview("exit 0", false)).toBe("exit 0");
  });

  it("keeps only the tail of long output until asked for all of it", () => {
    const output = Array.from({ length: 5_000 }, (_, line) => `line ${line}`).join("\n");
    const preview = structuredValuePreview(output, false);
    expect(preview).toHaveLength(STRUCTURED_VALUE_PREVIEW_CHARS);
    expect(output.endsWith(preview)).toBe(true);
    expect(structuredValuePreview(output, true)).toBe(output);
  });
});

describe("formatStructuredValuePreview", () => {
  it("matches JSON.stringify for values within the budget", () => {
    const value = {
      text: 'quote " and \u2028 newline\n',
      count: 3,
      ratio: Number.NaN,
      flag: false,
      none: null,
      skipped: undefined,
      fn: () => 1,
      at: new Date(0),
      custom: { toJSON: (key: string) => `custom:${key}` },
      empty: { list: [], object: {}, onlyUndefined: { gone: undefined } },
      list: [1, undefined, () => 2, "two", [{ nested: true }]],
    };
    expect(formatStructuredValuePreview(value)).toEqual({
      text: JSON.stringify(value, null, 2),
      truncated: false,
    });
    expect(formatStructuredValuePreview("plain")).toEqual({ text: '"plain"', truncated: false });
    expect(formatStructuredValuePreview(undefined)).toEqual({ text: "", truncated: false });
  });

  it("keeps the head of a large string without formatting all of it", () => {
    const value = { arguments: { path: "notes.md", content: "x".repeat(4_000_000) } };
    const preview = formatStructuredValuePreview(value);
    expect(preview.truncated).toBe(true);
    expect(preview.text).toHaveLength(STRUCTURED_VALUE_PREVIEW_CHARS);
    expect(JSON.stringify(value, null, 2).startsWith(preview.text)).toBe(true);
  });

  it("stops visiting a wide array once the budget is spent", () => {
    const visit = vi.fn(() => "entry");
    const value = Array.from({ length: 100_000 }, () => ({ toJSON: visit }));
    const preview = formatStructuredValuePreview(value);
    expect(preview.truncated).toBe(true);
    expect(JSON.stringify(value, null, 2).startsWith(preview.text)).toBe(true);
    visit.mockClear();
    formatStructuredValuePreview(value);
    // Each entry adds 11 characters (`,\n  "entry"`), so only ~1,800 of 100,000 are touched.
    expect(visit.mock.calls.length).toBeLessThan(2_000);
  });
});

it("previews a large object input and serializes it whole only on request", async () => {
  const input = { arguments: { content: "y".repeat(100_000) } };
  if (row.item.type !== "command_execution") throw new Error("Expected command");
  const { output: _output, outputPreview: _outputPreview, ...base } = row.item;
  const dynamicTool: OrchestrationV2ProjectedTurnItem = {
    ...row,
    item: { ...base, type: "dynamic_tool", toolName: "write", input },
  };
  await act(async () => {
    renderer = create(view(dynamicTool));
  });
  const inputText = () => renderer!.root.findAllByType("pre")[0]!.props.children;
  const showAll = () =>
    renderer!.root.findAllByType("button").find((button) => button.props.children === "Show all");
  expect(inputText()).toHaveLength(STRUCTURED_VALUE_PREVIEW_CHARS);
  await act(async () => {
    showAll()!.props.onClick();
  });
  expect(inputText()).toBe(JSON.stringify(input, null, 2));
  expect(showAll()).toBeUndefined();
});

it("keeps both preview edges and fetches inherited output only when expanded", async () => {
  await act(async () => {
    renderer = create(view());
  });
  expect(outputText()).toBe(output);
  expect(requests.load).not.toHaveBeenCalled();
  let finish!: (value: { text: string }) => void;
  requests.load.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let click!: Promise<void>;
  await act(async () => {
    click = expandButton().props.onClick();
  });
  expect(requests.connection).toHaveBeenCalledWith(environmentId);
  expect(requests.fetch).toHaveBeenCalledWith({
    prepared,
    threadId: sourceThreadId,
    itemId: row.item.id,
  });
  expect(
    renderer!.root
      .findAllByType("button")
      .some((button) => button.props.disabled && button.props.children === "Loading output…"),
  ).toBe(true);
  await act(async () => {
    finish({ text: "complete output" });
    await click;
  });
  expect(outputText()).toBe("complete output");
  expect(expandButton()).toBeUndefined();
});

it("shows a failed fetch and allows retry after reconnecting", async () => {
  requests.connection.mockReturnValue(null);
  await act(async () => {
    renderer = create(view());
  });
  await act(async () => {
    await expandButton().props.onClick();
  });
  expect(renderer!.root.findByProps({ role: "alert" }).props.children).toContain("Try again");
  expect(outputText()).toBe(output);
  expect(requests.load).not.toHaveBeenCalled();
  requests.connection.mockReturnValue(prepared);
  requests.load.mockRejectedValueOnce(new Error("environment unavailable"));
  await act(async () => {
    await expandButton().props.onClick();
  });
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  requests.load.mockResolvedValue({ text: "complete output" });
  await act(async () => {
    await expandButton().props.onClick();
  });
  expect(outputText()).toBe("complete output");
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});

it("invalidates fetched output when the running item receives a newer revision", async () => {
  requests.load.mockResolvedValue({ text: "previous output" });
  await act(async () => {
    renderer = create(view());
  });
  await act(async () => {
    await expandButton().props.onClick();
  });
  expect(outputText()).toBe("previous output");
  await act(async () => {
    renderer!.update(
      view({
        ...row,
        item: { ...row.item, updatedAt: DateTime.makeUnsafe("2026-10-07T00:01:00Z") },
      }),
    );
  });
  expect(outputText()).toBe(output);
  expect(expandButton()).toBeDefined();
});

it("expands legacy inline output locally", async () => {
  if (row.item.type !== "command_execution") throw new Error("Expected command");
  const { outputPreview: _, ...item } = row.item;
  const fullOutput = output.repeat(5);
  await act(async () => {
    renderer = create(view({ ...row, item: { ...item, output: fullOutput } }));
  });
  expect(outputText()).toHaveLength(STRUCTURED_VALUE_PREVIEW_CHARS);
  await act(async () => {
    await expandButton().props.onClick();
  });
  expect(outputText()).toBe(fullOutput);
  expect(requests.load).not.toHaveBeenCalled();
});
