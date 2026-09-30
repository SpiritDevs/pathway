export interface PendingDraftSendHold {
  readonly title: string;
  readonly description: string;
}

/**
 * What a sent draft is waiting on, shared by its sidebar row and its timeline
 * row. A send to a connected environment is working; one whose environment is
 * offline or unknown to this client is waiting, and can be restored as a draft.
 */
export function pendingDraftSendHold(
  environment: { readonly label: string; readonly connection: { readonly phase: string } } | null,
): PendingDraftSendHold | null {
  if (environment?.connection.phase === "connected") return null;
  return {
    title: environment ? `Waiting for ${environment.label}` : "Waiting for environment",
    description: `${environment?.label ?? "This chat's environment"} is not connected. The chat appears here once it connects. Restore the draft to edit or resend the message.`,
  };
}
