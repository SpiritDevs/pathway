import type {
  MessageId,
  OrchestrationV2ThreadHistory,
  OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus =
  | "empty"
  | "cached"
  | "synchronizing"
  | "live"
  | "deleted"
  | "stopped";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  readonly history?: EnvironmentThreadHistory;
}

export type ThreadHistoryDirection =
  | "older"
  | "newer"
  | "latest"
  | { readonly aroundMessageId: MessageId };

export interface EnvironmentThreadHistory extends OrchestrationV2ThreadHistory {
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly request: (direction: ThreadHistoryDirection) => void;
  readonly retry: () => void;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
};

export const STOPPED_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "stopped",
  error: Option.none(),
};
