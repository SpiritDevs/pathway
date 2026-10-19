import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createTerminalEnvironmentAtoms } from "./terminal.ts";

it("does not retain collapsed previews or evict the normal terminal attachment", () => {
  const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
    EnvironmentRegistry,
    never
  >;
  const terminal = createTerminalEnvironmentAtoms(runtime);
  const target = {
    environmentId: EnvironmentId.make("env"),
    input: { threadId: ThreadId.make("thread"), terminalId: "setup" },
  };
  const preview = terminal.previewAttach(target);
  const normal = terminal.attach(target);
  expect(preview.idleTTL).toBe(0);
  expect(normal.idleTTL).toBe(5 * 60_000);
  expect(preview).not.toBe(normal);
});
