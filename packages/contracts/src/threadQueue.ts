/** Durable user intent, independently of the destination environment's connectivity. */
import type { ChatAttachment } from "./chatAttachment.ts";
import type {
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
} from "./orchestrationV2.ts";
import type { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";

export type ThreadQueueSubmission =
  | { readonly kind: "launch"; readonly input: OrchestrationV2ThreadLaunchInput }
  | {
      readonly kind: "message";
      readonly input: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
      readonly runtimeMode?: RuntimeMode;
      readonly interactionMode?: ProviderInteractionMode;
    };

export type ThreadQueueState = "queued" | "accepted" | "delivered" | "blocked" | "canceled";

export interface ThreadQueueThread {
  readonly threadId: string;
  readonly environmentId: string;
  readonly localProjectId: string | null;
  readonly cloudProjectId: string | null;
  readonly title: string;
  readonly launch: Omit<OrchestrationV2ThreadLaunchInput, "initialMessage"> | null;
  readonly state: ThreadQueueState;
  readonly error: string | null;
  readonly revision: number;
  readonly acceptedAt: number | null;
  readonly queuedCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ThreadQueueMessage {
  readonly deliveryAttempt?: number;
  readonly rejection?: "command" | "initial-message" | null;
  readonly commandId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly state: ThreadQueueState;
  readonly error: string | null;
  readonly submission: ThreadQueueSubmission;
  readonly attachmentIds: readonly string[];
  readonly acceptedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ThreadQueueDetail {
  readonly thread: ThreadQueueThread;
  readonly messages: readonly ThreadQueueMessage[];
  /** Cloud download URLs for visible message attachments, keyed by ChatAttachment.id. */
  readonly attachmentUrls?: Readonly<Record<string, string>>;
}

/** Authoritative receipt identity for reconciling a send whose response was lost. */
export interface ThreadQueueSubmissionStatus {
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly state: ThreadQueueState;
  readonly revision: number;
  readonly deliveryAttempt: number;
}

export interface ThreadQueueHead {
  /** Advances only after the environment proves the previous command was durably rejected. */
  readonly deliveryAttempt?: number;
  /** Present on current backends so a failed preflight can retain an existing acceptance fence. */
  readonly state?: "queued" | "accepted";
  readonly threadId: string;
  readonly commandId: string;
  readonly revision: number;
}

export interface ThreadQueueAcceptance extends ThreadQueueHead {
  readonly state: "queued" | "accepted";
  readonly submission: ThreadQueueSubmission;
  readonly localProjectId: string | null;
  readonly issuedByMembershipId: string;
  readonly attachments: readonly { readonly attachment: ChatAttachment; readonly url: string }[];
}

export interface ThreadQueueDestination {
  readonly environmentId: string;
  readonly durableThreadQueue: boolean;
  readonly label: string;
  readonly projects: readonly {
    readonly localProjectId: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly cloudProjectId: string;
  }[];
  readonly providers: readonly {
    readonly instanceId: string;
    readonly driver: string;
    readonly displayName: string;
    readonly modelIds: readonly string[];
    readonly enabled: boolean;
    readonly available: boolean;
  }[];
}
