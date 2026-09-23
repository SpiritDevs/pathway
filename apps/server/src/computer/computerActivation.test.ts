import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, type OrchestrationV2Command, ThreadId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  admitRunComputerControl,
  commandRequestsComputer,
  computerActivationMetadata,
  providerComputerInvocationText,
} from "./computerActivation.ts";
import { ComputerControlStateError } from "./ComputerControlState.ts";
import type { ComputerManager } from "./ComputerManager.ts";
import type { ComputerServiceShape } from "./Services/ComputerService.ts";

describe("user dispatch Computer activation", () => {
  it("enables chat control from the switch and keeps its generation", () => {
    expect(
      computerActivationMetadata({
        enableComputerControl: true,
        computerControlGeneration: 7,
      }),
    ).toEqual({
      computerControlMode: "chat",
      enableComputerControl: true,
      computerControlGeneration: 7,
    });
  });
  it("stays off when the switch is off and defaults the generation", () => {
    expect(computerActivationMetadata({ enableComputerControl: false })).toEqual({
      computerControlMode: "off",
      enableComputerControl: false,
      computerControlGeneration: 0,
    });
    expect(computerActivationMetadata({})).toEqual({
      computerControlMode: "off",
      enableComputerControl: false,
      computerControlGeneration: 0,
    });
  });
  it("freezes a deliberate user command as request mode without changing its generation", () => {
    expect(
      computerActivationMetadata({
        enableComputerControl: false,
        userMessageText: "/computer-use open Calculator",
        computerControlGeneration: 3,
      }),
    ).toEqual({
      computerControlMode: "request",
      enableComputerControl: true,
      computerControlGeneration: 3,
    });
  });
  it("replays the frozen mode instead of promoting an enabled request to chat", () => {
    expect(
      computerActivationMetadata({ computerControlMode: "request", enableComputerControl: true })
        .computerControlMode,
    ).toBe("request");
    expect(
      computerActivationMetadata({ computerControlMode: "off", enableComputerControl: true })
        .enableComputerControl,
    ).toBe(false);
  });
  it("re-evaluates fresh edited text rather than inheriting one-shot intent", () => {
    expect(
      computerActivationMetadata({
        computerControlMode: "request",
        enableComputerControl: true,
        userMessageText: "Explain the result",
      }).computerControlMode,
    ).toBe("off");
    expect(
      computerActivationMetadata({
        computerControlMode: "chat",
        userMessageText: "Explain the result",
      }).computerControlMode,
    ).toBe("chat");
  });
  it.each(["agent", "automation"])(
    "never infers request consent from %s text",
    (dispatchOrigin) => {
      expect(
        computerActivationMetadata({
          userMessageText: "/computer-use open Calculator",
          dispatchOrigin,
        }).enableComputerControl,
      ).toBe(false);
    },
  );
});

describe("provider turn Computer activation", () => {
  it("sends the task, not the slash command, to the provider", () => {
    expect(providerComputerInvocationText("/computer-use open Calculator", "user")).toBe(
      "open Calculator",
    );
    expect(providerComputerInvocationText("/computer-use", "user")).toBe(
      "Use Pathway Computer for this task.",
    );
    expect(providerComputerInvocationText("/computer-use open Calculator", "agent")).toBe(
      "/computer-use open Calculator",
    );
    expect(providerComputerInvocationText("plain text", "user")).toBe("plain text");
  });

  it("gates dispatches that request Computer by switch or slash command", () => {
    const dispatch = {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:computer"),
      threadId: ThreadId.make("thread:computer"),
      messageId: MessageId.make("message:computer"),
      text: "plain text",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    } satisfies OrchestrationV2Command;
    expect(commandRequestsComputer(dispatch)).toBe(false);
    expect(commandRequestsComputer({ ...dispatch, enableComputerControl: true })).toBe(true);
    expect(commandRequestsComputer({ ...dispatch, text: "/computer-use open Calculator" })).toBe(
      true,
    );
  });

  const service = (admit: ComputerManager["admitControl"], supported = true) =>
    Option.some<ComputerServiceShape>({
      supported,
      availability: { kind: "available" } as ComputerServiceShape["availability"],
      manager: { admitControl: admit } as unknown as ComputerManager,
    });

  it.effect("admits the frozen intent against the host", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const admitted = yield* admitRunComputerControl({
        computer: service((...args) => {
          calls.push(args);
          return Effect.succeed(true);
        }),
        threadId: "thread:computer",
        computerControl: { mode: "request", generation: 4 },
        explicitInvocation: true,
      });
      expect(admitted).toBe(true);
      expect(calls).toEqual([["thread:computer", "request", 4, true]]);
    }),
  );

  it.effect("starts without Computer when the host refuses, is unsupported, or fails", () =>
    Effect.gen(function* () {
      const input = {
        threadId: "thread:computer",
        computerControl: { mode: "chat", generation: 1 },
        explicitInvocation: false,
      } as const;
      expect(
        yield* admitRunComputerControl({
          ...input,
          computer: service(() => Effect.succeed(false)),
        }),
      ).toBe(false);
      expect(
        yield* admitRunComputerControl({
          ...input,
          computer: service(() => Effect.succeed(true), false),
        }),
      ).toBe(false);
      expect(
        yield* admitRunComputerControl({
          ...input,
          computer: service(() => Effect.fail(new ComputerControlStateError({ message: "boom" }))),
        }),
      ).toBe(false);
      expect(
        yield* admitRunComputerControl({
          ...input,
          computerControl: undefined,
          computer: Option.none(),
        }),
      ).toBe(false);
    }),
  );
});
