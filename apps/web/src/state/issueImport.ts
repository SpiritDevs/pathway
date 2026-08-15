import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcStreamCommand,
  type AtomCommand,
  type AtomCommandResult,
} from "@spiritdevs/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type IssueImportExecuteResult,
  type IssueImportPreviewResult,
  type IssueImportRequest,
} from "@spiritdevs/contracts";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useAtomCommand } from "./use-atom-command";

export class IssueImportUnavailableError extends Data.TaggedError("IssueImportUnavailableError")<{
  readonly message: string;
}> {}

const previewCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:issue-import:preview",
  tag: WS_METHODS.cloudIssueImportPreview,
});

const executeCommand = createEnvironmentRpcStreamCommand(connectionAtomRuntime, {
  label: "environment-data:issue-import:execute",
  tag: WS_METHODS.cloudIssueImportExecute,
  concurrency: { mode: "singleFlight", key: (target) => target.input.companyId },
});

function usePrimaryImportCommand<A, E>(
  command: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: IssueImportRequest },
    A,
    E
  >,
) {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const run = useAtomCommand(command, { reportFailure: false, reportDefect: false });
  return useCallback(
    (input: IssueImportRequest): Promise<AtomCommandResult<A, E | IssueImportUnavailableError>> =>
      environmentId === null
        ? Promise.resolve(
            AsyncResult.fail(
              new IssueImportUnavailableError({
                message: "Connect to the primary environment before migrating issues.",
              }),
            ),
          )
        : run({ environmentId, input }),
    [environmentId, run],
  );
}

export const useIssueImportPreview = () =>
  usePrimaryImportCommand<IssueImportPreviewResult, unknown>(previewCommand);

export const useIssueImportExecute = () =>
  usePrimaryImportCommand<IssueImportExecuteResult, unknown>(executeCommand);
