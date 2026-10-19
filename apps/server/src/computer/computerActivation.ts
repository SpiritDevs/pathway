/**
 * The Computer activation a user dispatch freezes onto its turn.
 *
 * @module computer/computerActivation
 */
import type {
  ComputerControlMode,
  OrchestrationV2ConversationMessage,
  OrchestrationV2RunComputerControl,
} from "@spiritdevs/contracts";
import {
  parseComputerInvocation,
  resolveComputerInvocationMode,
} from "@spiritdevs/shared/computerInvocation";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ComputerServiceShape } from "./Services/ComputerService.ts";

/** Freeze explicit turn intent without promoting a slash invocation to chat access. */
export function computerActivationMetadata(input: {
  readonly enableComputerControl?: boolean | undefined;
  readonly computerControlMode?: ComputerControlMode | undefined;
  readonly computerControlGeneration?: number | undefined;
  /** Only the decider supplies fresh, user-authored text; replay uses frozen mode. */
  readonly userMessageText?: string | undefined;
  readonly dispatchOrigin?: string | undefined;
}): {
  computerControlMode: ComputerControlMode;
  enableComputerControl: boolean;
  computerControlGeneration: number;
} {
  const computerControlMode =
    input.userMessageText === undefined
      ? resolveComputerInvocationMode(input)
      : resolveComputerInvocationMode({
          messageText: input.userMessageText,
          dispatchOrigin: input.dispatchOrigin,
          enableComputerControl:
            input.computerControlMode === "chat" ||
            (input.computerControlMode === undefined && input.enableComputerControl === true),
        });
  return {
    computerControlMode,
    enableComputerControl: computerControlMode !== "off",
    computerControlGeneration: input.computerControlGeneration ?? 0,
  };
}

/** Pathway owns `/computer-use`: the transcript keeps it, the provider never sees it. */
export function providerComputerInvocationText(
  text: string,
  createdBy: OrchestrationV2ConversationMessage["createdBy"],
): string {
  const invocation = createdBy === "user" ? parseComputerInvocation(text) : null;
  return invocation === null ? text : invocation.prompt || "Use Pathway Computer for this task.";
}

/**
 * Admits a run's frozen Computer intent as its turn starts. Every turn owns its
 * exposure, so an ordinary turn also clears a chat default. Without a Computer
 * host the frozen intent alone decides; a failed admission fails closed.
 */
export const admitRunComputerControl = (input: {
  readonly computer: Option.Option<ComputerServiceShape>;
  readonly threadId: string;
  readonly computerControl: OrchestrationV2RunComputerControl | undefined;
  /** The run's own message is a user-authored `/computer-use`, which may re-arm a stopped thread. */
  readonly explicitInvocation: boolean;
}): Effect.Effect<boolean> => {
  const mode = input.computerControl?.mode ?? "off";
  if (Option.isNone(input.computer)) return Effect.succeed(mode !== "off");
  if (!input.computer.value.supported) return Effect.succeed(false);
  return input.computer.value.manager
    .admitControl(
      input.threadId,
      mode,
      input.computerControl?.generation ?? 0,
      mode === "request" && input.explicitInvocation,
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("[computer] turn admission failed; starting without Computer").pipe(
          Effect.annotateLogs({ threadId: input.threadId, cause: String(cause) }),
          Effect.as(false),
        ),
      ),
    );
};
